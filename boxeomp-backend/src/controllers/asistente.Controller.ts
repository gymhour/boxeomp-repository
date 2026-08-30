import dotenv from "dotenv";
import { Request, Response } from "express";
import { OpenAI } from "openai";
import path from "path";
import fs from "fs";
import { createHash } from "crypto";

dotenv.config();

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Missing OPENAI_API_KEY in environment");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === Config ===
const UPLOADS_DIR = path.resolve(process.cwd(), "uploads-asistente");
const VECTOR_STORE_NAME = process.env.RAG_VECTOR_STORE_NAME || "Gym Docs (RAG)";
const CACHE_PATH = path.resolve(process.cwd(), ".rag-vector-store-cache.json");
const PRESET_VECTOR_STORE_ID = process.env.OPENAI_VECTOR_STORE_ID || null;

// --- Cache local ---
type CacheShape = {
  vectorStoreId?: string;
  files?: Record<
    string,
    { fileId: string; checksum: string; mtimeMs: number; size: number }
  >;
};

function loadCache(): CacheShape {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return { files: {} };
  }
}
function saveCache(cache: CacheShape) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
}
function checksumFile(filePath: string) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

// --- Vector Store ---
async function ensureVectorStore(): Promise<string> {
  const cache = loadCache();

  if (PRESET_VECTOR_STORE_ID) {
    if (cache.vectorStoreId !== PRESET_VECTOR_STORE_ID) {
      cache.vectorStoreId = PRESET_VECTOR_STORE_ID;
      saveCache(cache);
    }
    return PRESET_VECTOR_STORE_ID;
  }

  if (cache.vectorStoreId) return cache.vectorStoreId;

  const vs = await openai.vectorStores.create({ name: VECTOR_STORE_NAME });
  cache.vectorStoreId = vs.id;
  saveCache(cache);
  return vs.id;
}

// --- Sync carpeta local -> Vector Store ---
async function syncFolderToVectorStore(vectorStoreId: string): Promise<number> {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
  const cache = loadCache();
  if (!cache.files) cache.files = {};

  const filenames = fs
    .readdirSync(UPLOADS_DIR, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name);

  const filesToUpload: string[] = [];
  for (const name of filenames) {
    const full = path.join(UPLOADS_DIR, name);
    const stat = fs.statSync(full);
    const checksum = checksumFile(full);
    const cached = cache.files[name];

    const changed =
      !cached ||
      cached.checksum !== checksum ||
      cached.mtimeMs !== stat.mtimeMs ||
      cached.size !== stat.size;

    if (changed) filesToUpload.push(full);
  }

  if (filesToUpload.length > 0) {
    const streams = filesToUpload.map((p) => fs.createReadStream(p));
    // helper oficial: sube y hace poll hasta "completed"
    await openai.vectorStores.fileBatches.uploadAndPoll(vectorStoreId, {
      files: streams as any,
    });

    // Construir mapa nombre->file_id recuperando metadata de cada file del vector store
    const page: any = await openai.vectorStores.files.list(vectorStoreId);
    const vsFiles = Array.isArray(page?.data) ? page.data : [];

    // Necesitamos filename; VectorStoreFile NO lo trae: hay que retrieve
    const entries = await Promise.all(
      vsFiles.map(async (vf: any) => {
        try {
          const f = await openai.files.retrieve(vf.id);
          return { fileId: vf.id, filename: (f as any).filename as string | undefined };
        } catch {
          return { fileId: vf.id, filename: undefined };
        }
      })
    );

    for (const filePath of filesToUpload) {
      const name = path.basename(filePath);
      const stat = fs.statSync(filePath);

      const match = entries.find((e) => e.filename === name);
      cache.files[name] = {
        fileId: match?.fileId || cache.files[name]?.fileId || "",
        checksum: checksumFile(filePath),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      };
    }
    saveCache(cache);
  }

  return filesToUpload.length;
}

// --- Prompt de sistema ---
function makeSystemPrompt() {
  return [
    "Eres un asistente del gimnasio.",
    "Responde ÚNICAMENTE con información de los documentos cargados.",
    "Si no está en los docs, indícalo y pide que el admin lo cargue.",
    "Responde claro, amable y profesional.",
    "Incluye siempre referencias (nombre de archivo).",
  ].join(" ");
}

// --- Util: extraer texto + citas ---
function extractTextAndCitations(resp: any): { text: string; citedFileIds: string[] } {
  const text = typeof resp?.output_text === "string" ? resp.output_text : "";

  const cited = new Set<string>();
  const output = resp?.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const block of content) {
        const ann = block?.annotations || block?.text?.annotations;
        if (Array.isArray(ann)) {
          for (const a of ann) {
            const fid =
              a?.file_citation?.file_id ||
              a?.file_path?.file_id ||
              a?.file_id;
            if (typeof fid === "string") cited.add(fid);
          }
        }
      }
    }
  }

  return { text, citedFileIds: Array.from(cited) };
}

// --- Controller principal ---
export const ragAsk = async (req: Request, res: Response) => {
  try {
    const { question } = req.body;
    if (typeof question !== "string" || !question.trim()) {
      res.status(400).json({ error: "Field 'question' must be a non-empty string" });
      return;
    }

    const vectorStoreId = await ensureVectorStore();
    await syncFolderToVectorStore(vectorStoreId);

    // Verificar que haya al menos 1 archivo
    const page: any = await openai.vectorStores.files.list(vectorStoreId);
    const hasFiles = Array.isArray(page?.data) && page.data.length > 0;
    if (!hasFiles) {
      res.status(400).json({
        error:
          "No hay documentos en el Vector Store. Agrega archivos a 'uploads-asistente' y reintenta.",
      });
      return;
    }

    // Responses API + File Search con vector_store_ids (requerido por tipos)
    const response = await openai.responses.create({
      model: process.env.OPENAI_RAG_MODEL || "gpt-4.1-mini",
      input: [
        { role: "system", content: makeSystemPrompt() },
        { role: "user", content: question },
      ],
      tools: [{ type: "file_search", vector_store_ids: [vectorStoreId] }],
      temperature: 0.2,
    });

    const { text, citedFileIds } = extractTextAndCitations(response);
    let answer = (text || "").trim();

    // Resolver filenames de las citas
    let sources: { id: string; filename: string }[] = [];
    if (citedFileIds.length > 0) {
      const unique = Array.from(new Set(citedFileIds)).slice(0, 10);
      const metas = await Promise.allSettled(unique.map((fid) => openai.files.retrieve(fid)));
      sources = metas
        .map((r) =>
          r.status === "fulfilled"
            ? { id: (r.value as any).id, filename: (r.value as any).filename || (r.value as any).id }
            : null
        )
        .filter(Boolean) as any[];
    }

    if (sources.length > 0) {
      answer += "\n\nFuentes:\n" + sources.map((s) => `• ${s.filename}`).join("\n");
    }

    if (!answer) {
      res.status(200).json({
        response: "No encontré esa información en los documentos del gimnasio. Probá preguntarlo de otra manera.",
        vectorStoreId,
        sources: [],
      });
      return;
    }

    res.json({ response: answer, vectorStoreId, sources });
  } catch (err: any) {
    console.error("[responder con el asistente]", err?.response?.data || err);
    res.status(500).json({
      message: "El asistente no está disponible en este momento. Probá de nuevo en unos minutos.",
    });
  }
};

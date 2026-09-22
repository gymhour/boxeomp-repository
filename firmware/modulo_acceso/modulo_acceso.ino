// Módulo de acceso — ESP32 + relé de cerradura magnética (piloto BoxeoMP).
// Mantiene un WebSocket saliente (TLS) contra la API y acciona el relé al recibir {"action":"open"}.
//
// Librerías necesarias (Gestor de librerías del IDE de Arduino):
//   - "WebSockets" de Markus Sattler (links2004) 2.7.2 o superior
//   - "ArduinoJson" 7.x
// Placa: ESP32 (core 3.x)
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include "secrets.h"            // WIFI_SSID, WIFI_PASS, DEVICE_TOKEN — NO subir a git

// ===================== CONFIGURACIÓN =====================
const char* WS_HOST = "boxeomp-repository-production.up.railway.app";
const uint16_t WS_PORT = 443;
const char* WS_PATH = "/device";   // el token NO va en la URL: viaja en el header Authorization

#define PIN_RELE            26
#define PIN_LED              2
#define RELE_ACTIVO       HIGH   // nivel que ABRE. Si tu módulo de relé es "active LOW", poné LOW
#define RELE_REPOSO       (RELE_ACTIVO == HIGH ? LOW : HIGH)
#define PULSO_MS           500
#define WIFI_TIMEOUT_MS  30000
// =========================================================

// Raíces de confianza de Let's Encrypt (ISRG) para validar el certificado de *.up.railway.app.
// Sin CA la librería hace setInsecure() y cualquiera en la red podría hacerse pasar por la API.
// Van 3 raíces para que siga validando cuando Let's Encrypt cambie la cadena intermedia.
// Huellas SHA-256 verificadas contra letsencrypt.org:
//   ISRG Root X1  96:BC:EC:06:26:49:76:F3:74:60:77:9A:CF:28:C5:A7:CF:E8:A3:C0:AA:E1:1A:8F:FC:EE:05:C0:BD:DF:08:C6 (2035)
//   ISRG Root X2  69:72:9B:8E:15:A8:6E:FC:17:7A:57:AF:B7:17:1D:FC:64:AD:D2:8C:2F:CA:8C:F1:50:7E:34:45:3C:CB:14:70 (2040)
//   ISRG Root YE  E1:4F:FC:AD:5B:00:25:73:10:06:CA:A4:3A:12:1A:22:D8:E9:70:0F:4F:B9:CF:85:2F:02:A7:08:AA:5D:56:66 (2045)
static const char ROOT_CA[] = R"EOF(
-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw
TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh
cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4
WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu
ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY
MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc
h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+
0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U
A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW
T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH
B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC
B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv
KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn
OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn
jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw
qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI
rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV
HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq
hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL
ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ
3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK
NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5
ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur
TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC
jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc
oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq
4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA
mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d
emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIICGzCCAaGgAwIBAgIQQdKd0XLq7qeAwSxs6S+HUjAKBggqhkjOPQQDAzBPMQsw
CQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJuZXQgU2VjdXJpdHkgUmVzZWFyY2gg
R3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBYMjAeFw0yMDA5MDQwMDAwMDBaFw00
MDA5MTcxNjAwMDBaME8xCzAJBgNVBAYTAlVTMSkwJwYDVQQKEyBJbnRlcm5ldCBT
ZWN1cml0eSBSZXNlYXJjaCBHcm91cDEVMBMGA1UEAxMMSVNSRyBSb290IFgyMHYw
EAYHKoZIzj0CAQYFK4EEACIDYgAEzZvVn4CDCuwJSvMWSj5cz3es3mcFDR0HttwW
+1qLFNvicWDEukWVEYmO6gbf9yoWHKS5xcUy4APgHoIYOIvXRdgKam7mAHf7AlF9
ItgKbppbd9/w+kHsOdx1ymgHDB/qo0IwQDAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0T
AQH/BAUwAwEB/zAdBgNVHQ4EFgQUfEKWrt5LSDv6kviejM9ti6lyN5UwCgYIKoZI
zj0EAwMDaAAwZQIwe3lORlCEwkSHRhtFcP9Ymd70/aTSVaYgLXTWNLxBo1BfASdW
tL4ndQavEi51mI38AjEAi/V3bNTIZargCyzuFJ0nN6T5U6VR5CmD1/iQMVtCnwr1
/q4AaOeMSQ+2b1tbFfLn
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIB2TCCAWCgAwIBAgIRAKQCa6LvbHwg1AR+XmWmk4AwCgYIKoZIzj0EAwMwLjEL
MAkGA1UEBhMCVVMxDTALBgNVBAoTBElTUkcxEDAOBgNVBAMTB1Jvb3QgWUUwHhcN
MjUwOTAzMDAwMDAwWhcNNDUwOTAyMjM1OTU5WjAuMQswCQYDVQQGEwJVUzENMAsG
A1UEChMESVNSRzEQMA4GA1UEAxMHUm9vdCBZRTB2MBAGByqGSM49AgEGBSuBBAAi
A2IABDwS/6vhrcVqcbBo+wgdI3fwn9x7DNJJOY/lTOti0vkwuRN87RhEhTH17E7X
yFjWsPYhIPt/wzOqxTd2b+4ZJNy9ID04YywF9U5zasDVyGSNErVNtz8uSGh5izW8
7j77GaNCMEAwDgYDVR0PAQH/BAQDAgEGMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0O
BBYEFKPIJlqOoUzQNWP8myPIOq5W809WMAoGCCqGSM49BAMDA2cAMGQCMHhMr8N9
LdL1VQKs9BdV81r76eXRB6mtjuNjzk6/lBsPNToWLTDzGYgtQKO1jl63uAIwGV7m
onyF377c+MM1oqVNs17sgu7F9YKZwgLmVbeOMDbKAXHtKMDLbiGllCcs8f47
-----END CERTIFICATE-----
)EOF";

WebSocketsClient ws;

bool releActivo = false;
unsigned long releInicio = 0;

void releEnReposo() {
  digitalWrite(PIN_RELE, RELE_REPOSO);
  releActivo = false;
}

void abrirPuerta(long checkinId) {
  Serial.printf(">>> ABRIENDO (checkin %ld)\n", checkinId);
  digitalWrite(PIN_RELE, RELE_ACTIVO);
  releInicio = millis();
  releActivo = true;   // se apaga en loop(): nada de delay() que frene el WebSocket
}

void actualizarRele() {
  if (releActivo && millis() - releInicio >= PULSO_MS) {
    releEnReposo();
    Serial.println(">>> Pulso terminado");
  }
}

void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      digitalWrite(PIN_LED, HIGH);
      Serial.println("[WS] Conectado a la API");
      break;

    case WStype_DISCONNECTED:
      digitalWrite(PIN_LED, LOW);
      Serial.println("[WS] Desconectado. Reintentando...");
      break;

    case WStype_TEXT: {
      JsonDocument doc;
      DeserializationError err = deserializeJson(doc, payload, length);
      if (err) {
        Serial.printf("[WS] JSON invalido: %s\n", err.c_str());
        break;
      }
      const char* action = doc["action"] | "";
      if (strcmp(action, "open") == 0) {
        abrirPuerta(doc["checkinId"] | 0L);
      }
      break;
    }

    default:
      break;
  }
}

void conectarWifi() {
  releEnReposo();   // si se cortó el WiFi en medio de un pulso, la puerta vuelve a cerrar
  digitalWrite(PIN_LED, LOW);

  Serial.print("[WIFI] Conectando");
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  unsigned long inicio = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - inicio > WIFI_TIMEOUT_MS) {
      Serial.println("\n[WIFI] Sin conexion tras 30 s. Reiniciando el modulo...");
      ESP.restart();
    }
    delay(500);
    Serial.print(".");
  }
  Serial.println("\n[WIFI] IP: " + WiFi.localIP().toString());
  Serial.printf("[WIFI] Senal: %d dBm\n", WiFi.RSSI());
}

void setup() {
  // En el core 3.x digitalWrite() no tiene efecto antes de pinMode(): configuramos y fijamos reposo al instante.
  pinMode(PIN_RELE, OUTPUT);
  digitalWrite(PIN_RELE, RELE_REPOSO);
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);

  Serial.begin(115200);
  delay(1000);
  Serial.println("\n=== Modulo de acceso ===");

  conectarWifi();

  // 1) begin primero: valida el certificado del servidor con ROOT_CA y resetea internamente la
  //    autorización (por eso el header va DESPUÉS).
  ws.beginSslWithCA(WS_HOST, WS_PORT, WS_PATH, ROOT_CA);

  // 2) Header "Authorization: Bearer <token>" (queda guardado para todas las reconexiones).
  String auth = String("Bearer ") + DEVICE_TOKEN;
  ws.setAuthorization(auth.c_str());

  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(5000);
  ws.enableHeartbeat(25000, 5000, 2);
}

void loop() {
  actualizarRele();

  if (WiFi.status() != WL_CONNECTED) {
    conectarWifi();   // pone el relé en reposo, reintenta y reinicia el módulo si no conecta en 30 s
  }

  ws.loop();
}

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import CustomInput from '../utils/CustomInput/CustomInput';
import apiService from '../../services/apiService';
import './CheckInSections.css';

const MIN_SEARCH_LENGTH = 2;
const SEARCH_DEBOUNCE_MS = 300;
const MAX_SUGGESTIONS = 8;

const soloDigitos = value => value.replace(/\D/g, '');
// Documento: sólo números (tolerando los puntos/guiones con los que se suele escribir).
// Cualquier otra cosa se interpreta como una búsqueda por nombre y apellido.
const esDocumento = value => /^[\d.\s-]+$/.test(value);

const nombreCompleto = usuario => (
  `${usuario?.nombre || ''} ${usuario?.apellido || ''}`.trim() || `ID ${usuario?.ID_Usuario}`
);

/**
 * Ingreso por DNI. Con `enableNameSearch` (sólo el panel del admin) el mismo input acepta
 * además nombre y apellido: busca al alumno y, al elegirlo, deja su DNI en el input. El
 * ingreso siempre se registra por DNI — la búsqueda por nombre es sólo para encontrarlo.
 */
const DNICheckInSection = ({ onCheckIn, loading, enableNameSearch = false }) => {
  const [dni, setDni] = useState('');
  const [alumnoElegido, setAlumnoElegido] = useState(null);
  const [sugerencias, setSugerencias] = useState([]);
  const [buscando, setBuscando] = useState(false);
  const [listaAbierta, setListaAbierta] = useState(false);
  const [indiceActivo, setIndiceActivo] = useState(-1);
  const [aviso, setAviso] = useState('');
  const dniInputRef = useRef(null);

  const termino = dni.trim();
  // Mientras se escriben números el input se comporta como siempre (DNI directo, sin lista):
  // así el flujo rápido de recepción —tipear documento y Enter— no cambia.
  const buscandoPorNombre = enableNameSearch && termino.length > 0 && !esDocumento(termino);
  const dniAEnviar = useMemo(() => {
    if (esDocumento(termino)) return soloDigitos(termino);
    return alumnoElegido?.dni ? String(alumnoElegido.dni) : '';
  }, [termino, alumnoElegido]);

  const limpiarBusqueda = () => {
    setSugerencias([]);
    setListaAbierta(false);
    setIndiceActivo(-1);
  };

  const limpiarTodo = () => {
    setDni('');
    setAlumnoElegido(null);
    setAviso('');
    limpiarBusqueda();
  };

  useEffect(() => {
    if (!buscandoPorNombre || termino.length < MIN_SEARCH_LENGTH) {
      setBuscando(false);
      limpiarBusqueda();
      return undefined;
    }

    let vigente = true;
    setBuscando(true);
    const timeoutId = setTimeout(async () => {
      try {
        const response = await apiService.getAllUsuarios({
          page: 1,
          take: MAX_SUGGESTIONS,
          tipo: 'cliente',
          estado: true,
          search: termino,
        });

        if (!vigente) return;
        setSugerencias(Array.isArray(response?.data) ? response.data : []);
        setListaAbierta(true);
        setIndiceActivo(-1);
      } catch (error) {
        if (!vigente) return;
        console.error('Error buscando alumnos por nombre:', error);
        setSugerencias([]);
        setListaAbierta(true);
      } finally {
        if (vigente) setBuscando(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      vigente = false;
      clearTimeout(timeoutId);
    };
  }, [buscandoPorNombre, termino]);

  const handleChange = event => {
    const valor = event.target.value;
    setDni(enableNameSearch ? valor : soloDigitos(valor));
    setAlumnoElegido(null);
    setAviso('');
  };

  // Al elegir un alumno el input queda con su DNI: el admin ve exactamente con qué
  // documento se va a registrar el ingreso antes de confirmarlo.
  const elegirAlumno = usuario => {
    if (!usuario?.dni) return;
    setAlumnoElegido(usuario);
    setDni(String(usuario.dni));
    setAviso('');
    limpiarBusqueda();
    dniInputRef.current?.focus();
  };

  const seleccionables = sugerencias.filter(usuario => usuario?.dni);

  const handleKeyDown = event => {
    if (!listaAbierta || seleccionables.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIndiceActivo(prev => (prev + 1) % seleccionables.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIndiceActivo(prev => (prev <= 0 ? seleccionables.length - 1 : prev - 1));
    } else if (event.key === 'Enter' && indiceActivo >= 0) {
      event.preventDefault();
      elegirAlumno(seleccionables[indiceActivo]);
    } else if (event.key === 'Enter' && seleccionables.length === 1) {
      // Un único alumno posible: Enter lo elige. Con varios resultados no se adivina —
      // sólo se elige lo que el admin marcó con las flechas o con el mouse.
      event.preventDefault();
      elegirAlumno(seleccionables[0]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      limpiarBusqueda();
    }
  };

  const handleSubmit = async event => {
    event.preventDefault();
    if (loading) return;

    if (!dniAEnviar) {
      setAviso(
        buscandoPorNombre
          ? 'Elegí un alumno de la lista para registrar el ingreso con su DNI.'
          : 'Ingresá un DNI para validar el acceso.'
      );
      return;
    }

    await onCheckIn(dniAEnviar);
    limpiarTodo();
    dniInputRef.current?.focus();
  };

  return (
    <form className="checkin-section" onSubmit={handleSubmit}>
      <div className="checkin-section-header">
        <h3>Ingreso por DNI</h3>
        <p>
          {enableNameSearch
            ? 'Ingresá el documento del alumno, o buscalo por nombre y apellido: el ingreso se registra siempre con su DNI.'
            : 'Ingresá el documento del alumno para validar su acceso.'}
        </p>
      </div>
      <div className="dni-checkin-row">
        <div className="dni-checkin-field">
          <CustomInput
            ref={dniInputRef}
            value={dni}
            onChange={handleChange}
            onKeyDown={enableNameSearch ? handleKeyDown : undefined}
            onFocus={() => { if (sugerencias.length > 0) setListaAbierta(true); }}
            onBlur={() => setListaAbierta(false)}
            placeholder={enableNameSearch ? 'DNI, nombre o apellido' : 'Ingresar DNI'}
            inputMode={enableNameSearch ? 'text' : 'numeric'}
            autoComplete="off"
            autoFocus
            aria-label={enableNameSearch ? 'DNI, nombre o apellido del alumno' : 'DNI del alumno'}
            aria-expanded={enableNameSearch ? listaAbierta : undefined}
            role={enableNameSearch ? 'combobox' : undefined}
            maxLength={enableNameSearch ? 60 : 10}
            width="100%"
            className="dni-checkin-input"
          />

          {enableNameSearch && listaAbierta && buscandoPorNombre && (
            <ul className="dni-checkin-suggestions" role="listbox">
              {buscando && sugerencias.length === 0 && (
                <li className="dni-checkin-suggestion-empty">Buscando alumnos…</li>
              )}

              {!buscando && sugerencias.length === 0 && (
                <li className="dni-checkin-suggestion-empty">No se encontraron alumnos activos con ese nombre.</li>
              )}

              {sugerencias.map(usuario => {
                const sinDni = !usuario?.dni;
                const posicion = seleccionables.indexOf(usuario);

                return (
                  <li key={usuario.ID_Usuario}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={posicion >= 0 && posicion === indiceActivo}
                      className={`dni-checkin-suggestion${posicion >= 0 && posicion === indiceActivo ? ' is-active' : ''}${sinDni ? ' is-disabled' : ''}`}
                      // Sin esto el blur del input cierra la lista antes de que llegue el click.
                      onMouseDown={event => event.preventDefault()}
                      onMouseEnter={() => { if (posicion >= 0) setIndiceActivo(posicion); }}
                      onClick={() => elegirAlumno(usuario)}
                      disabled={sinDni}
                      title={sinDni ? 'El alumno no tiene DNI cargado' : `Ingresar con DNI ${usuario.dni}`}
                    >
                      <span className="dni-checkin-suggestion-name">{nombreCompleto(usuario)}</span>
                      <span className="dni-checkin-suggestion-dni">
                        {sinDni ? 'Sin DNI cargado' : `DNI ${usuario.dni}`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <button type="submit" className="attendance-primary-action" disabled={loading || !dniAEnviar}>
          {loading ? 'Verificando...' : 'Verificar ingreso'}
        </button>
      </div>

      {enableNameSearch && alumnoElegido && (
        <div className="dni-checkin-selected" role="status">
          <Search size={16} />
          <span>
            Ingreso de <strong>{nombreCompleto(alumnoElegido)}</strong> con DNI <strong>{alumnoElegido.dni}</strong>
          </span>
          <button type="button" onClick={limpiarTodo} aria-label="Quitar alumno seleccionado" title="Quitar alumno seleccionado">
            <X size={15} />
          </button>
        </div>
      )}

      {enableNameSearch && aviso && (
        <p className="dni-checkin-hint" role="alert">{aviso}</p>
      )}
    </form>
  );
};

export default DNICheckInSection;

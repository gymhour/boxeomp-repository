import React, { useEffect, useMemo, useState } from 'react';
import { Copy, Monitor, ShieldCheck, X, XCircle } from 'lucide-react';
import SidebarMenu from '../../../Components/SidebarMenu/SidebarMenu';
import DNICheckInSection from '../../../Components/Attendances/DNICheckInSection';
import QRCheckInSection from '../../../Components/Attendances/QRCheckInSection';
import CheckInResultCard from '../../../Components/Attendances/CheckInResultCard';
import apiService from '../../../services/apiService';
import './AdminCheckInPage.css';

const CHECKIN_TABS = {
  DNI: 'dni',
  QR: 'qr',
};

// El ingreso confirmado se cierra rápido para no demorar la fila. El rechazo se queda
// mucho más: hay que alcanzar a leer el motivo y explicárselo al alumno.
const RESULT_TIMEOUT_MS = 2000;
const REJECTED_RESULT_TIMEOUT_MS = 10000;

const AdminCheckInPage = () => {
  const [activeTab, setActiveTab] = useState(CHECKIN_TABS.DNI);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [kioskCopied, setKioskCopied] = useState(false);
  const [stationAuthorized, setStationAuthorized] = useState(() => apiService.isThisStationAuthorized());
  const [stationLoading, setStationLoading] = useState(false);
  const [stationError, setStationError] = useState('');
  const [deviceOnline, setDeviceOnline] = useState(null);

  // URL genérica para la PC de la entrada (modo kiosko: auto-reset, sin salida a login)
  const kioskUrl = useMemo(() => {
    if (typeof window === 'undefined') return '/ingreso?mode=kiosk';
    return new URL('/ingreso?mode=kiosk', window.location.origin).toString();
  }, []);

  const handleCopyKioskUrl = async () => {
    try {
      await navigator.clipboard.writeText(kioskUrl);
      setKioskCopied(true);
      setTimeout(() => setKioskCopied(false), 1800);
    } catch {
      setKioskCopied(false);
    }
  };

  // Estado del módulo de puerta (se refresca cada 30 s mientras la pantalla está abierta).
  useEffect(() => {
    let cancelled = false;
    const loadDeviceStatus = async () => {
      try {
        const { conectado } = await apiService.getDeviceStatus();
        if (!cancelled) setDeviceOnline(Boolean(conectado));
      } catch {
        if (!cancelled) setDeviceOnline(null);
      }
    };
    loadDeviceStatus();
    const intervalId = setInterval(loadDeviceStatus, 30000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  const handleAuthorizeStation = async () => {
    setStationLoading(true);
    setStationError('');
    try {
      await apiService.authorizeThisStation();
      setStationAuthorized(true);
    } catch (error) {
      setStationError(error.message);
    } finally {
      setStationLoading(false);
    }
  };

  const handleRevokeStation = () => {
    apiService.revokeThisStation();
    setStationAuthorized(false);
  };

  useEffect(() => {
    if (!result) return undefined;

    const timeoutId = setTimeout(() => {
      setResult(null);
    }, result.allowed ? RESULT_TIMEOUT_MS : REJECTED_RESULT_TIMEOUT_MS);

    return () => clearTimeout(timeoutId);
  }, [result]);

  const runCheckIn = async action => {
    setLoading(true);
    try {
      const data = await action();
      setResult(data);
    } catch (error) {
      setResult({
        allowed: false,
        status: 'rejected',
        message: error.message || 'No se pudo verificar el ingreso.',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page-layout">
      <SidebarMenu isAdmin={true} />
      <main className="content-layout admin-checkin-page">
        <div className="attendance-page-header">
          <div>
            <h2>Ingreso</h2>
            <p>Validación rápida para recepción por DNI o QR.</p>
          </div>
        </div>

        <div className="checkin-tabs" role="tablist" aria-label="Método de ingreso">
          <button
            type="button"
            className={activeTab === CHECKIN_TABS.DNI ? 'active' : ''}
            onClick={() => setActiveTab(CHECKIN_TABS.DNI)}
          >
            DNI
          </button>
          <button
            type="button"
            className={activeTab === CHECKIN_TABS.QR ? 'active' : ''}
            onClick={() => setActiveTab(CHECKIN_TABS.QR)}
          >
            QR
          </button>
        </div>

        <div className="checkin-layout">
          <div className="checkin-method-container">
            {activeTab === CHECKIN_TABS.DNI ? (
              <>
                <DNICheckInSection
                  loading={loading}
                  enableNameSearch
                  onCheckIn={dni => runCheckIn(() => apiService.registerAttendance({ dni, method: 'DNI', asStaff: true }))}
                />

                {/* URL genérica para la PC de ingreso (modo kiosko) */}
                <section className="checkin-section" style={{ marginTop: '18px' }}>
                  <div className="checkin-section-header">
                    <h3>PC de ingreso (modo kiosko)</h3>
                    <p>
                      Abrí esta URL en el navegador de la computadora de la entrada (idealmente en pantalla
                      completa) para que los alumnos registren su asistencia ingresando el DNI.
                    </p>
                  </div>
                  <div className="qr-public-link">
                    <Monitor className="qr-link-icon" />
                    <span>{kioskUrl}</span>
                  </div>
                  <div className="qr-checkin-controls">
                    <button
                      type="button"
                      className="attendance-primary-action"
                      onClick={handleCopyKioskUrl}
                    >
                      <Copy size={18} />
                      {kioskCopied ? 'Link copiado' : 'Copiar link'}
                    </button>
                  </div>
                </section>

                {/* Apertura de puerta: solo PCs autorizadas o staff logueado disparan el relé */}
                <section className="checkin-section" style={{ marginTop: '18px' }}>
                  <div className="checkin-section-header">
                    <h3>Apertura de puerta</h3>
                    <p>
                      Módulo de puerta:{' '}
                      <strong>
                        {deviceOnline === null ? 'sin datos' : deviceOnline ? 'en línea' : 'desconectado'}
                      </strong>
                    </p>
                    <p>
                      Autorizá una sola vez la PC de la entrada o de recepción (logueado como admin). Los
                      ingresos desde PCs autorizadas y desde este panel abren la puerta; los que se hacen con
                      el celular por QR registran la asistencia pero no la abren.
                    </p>
                  </div>
                  <div className="qr-public-link">
                    {stationAuthorized
                      ? <ShieldCheck className="qr-link-icon" />
                      : <XCircle className="qr-link-icon" />}
                    <span>
                      {stationAuthorized
                        ? 'Esta PC está autorizada para abrir la puerta'
                        : 'Esta PC no está autorizada para abrir la puerta'}
                    </span>
                  </div>
                  {stationError && <p role="alert">{stationError}</p>}
                  <div className="qr-checkin-controls">
                    {stationAuthorized ? (
                      <button
                        type="button"
                        className="attendance-primary-action"
                        onClick={handleRevokeStation}
                      >
                        Quitar autorización
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="attendance-primary-action"
                        onClick={handleAuthorizeStation}
                        disabled={stationLoading}
                      >
                        <ShieldCheck size={18} />
                        {stationLoading ? 'Autorizando...' : 'Autorizar esta PC'}
                      </button>
                    )}
                  </div>
                </section>
              </>
            ) : (
              <QRCheckInSection
                publicPath="/ingreso?source=qr"
              />
            )}
          </div>
        </div>

        {result && (
          <div className="checkin-result-modal-overlay" role="status" aria-live="polite">
            <div className="checkin-result-modal">
              {/* El rechazo queda 12s en pantalla: si el admin ya lo leyó, puede cerrarlo
                  antes y seguir con el próximo ingreso sin esperar. */}
              <button
                type="button"
                className="checkin-result-modal-close"
                onClick={() => setResult(null)}
                aria-label="Cerrar"
                title="Cerrar"
              >
                <X size={20} />
              </button>
              <h3 className="checkin-result-modal-title">
                {result.allowed ? 'Turno confirmado' : 'Turno negado'}
              </h3>
              <CheckInResultCard result={result} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default AdminCheckInPage;

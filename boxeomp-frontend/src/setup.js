// ============================================================================
// CONFIGURACION POR CLIENTE
//
// Este es el punto central de configuracion visual y comercial del frontend.
// Para personalizar un cliente, agregar sus archivos en src/assets/client y
// editar solamente los imports y valores de este archivo.
// ============================================================================

// Logo blanco para fondos oscuros, variante carbón para fondos claros y
// versión cuadrada optimizada para favicon/PWA.
import logoLight from './assets/client/boxeomp_dark_logo.png';
import favicon from './assets/client/boxeomp_favicon.png';
import logoDark from './assets/client/boxeomp_white_logo.png';
import loginBackground from './assets/login/login_background.png';

const CLIENT_SETUP = {
  // REACT_APP_API_URL tiene prioridad en builds de cada ambiente.
  apiUrl: process.env.REACT_APP_API_URL || 'https://boxeomp-repository-production.up.railway.app/',

  branding: {
    name: 'BoxeoMP',
    logoAlt: 'BoxeoMP',
    logo: logoDark,
    logoLight,
    favicon,
    appleTouchIcon: favicon,
    loginBackground,
    metadata: {
      title: 'BoxeoMP',
      description: 'BoxeoMP — gestión de entrenamiento y gimnasio.',
      themeColor: '#E15158',
    },
    theme: {
      primaryColor: '#E15158',
      primaryColorHover: '#C43F47',
      backgroundHoverColor: '#E1515826',
    },
  },

  payment: {
    // TODO(boxeomp): completar cuando recibamos los datos reales del cliente.
    accountHolder: 'BOXEOMP',
    alias: '',
    cbu: '',
    cuil: '',
    whatsapp: {
      // Código de país incluido, sin el signo "+".
      // TODO(boxeomp): reemplazar por el WhatsApp real del cliente.
      phoneNumber: '5493510000000',
      message: 'Hola BoxeoMP! Les comparto el comprobante de pago de este mes:',
    },
  },
};

const setMetaContent = (selector, content) => {
  if (!content) return;
  document.querySelector(selector)?.setAttribute('content', content);
};

const setLinkHref = (selector, href) => {
  if (!href) return;
  document.querySelector(selector)?.setAttribute('href', href);
};

// Aplica la configuración antes de renderizar React para evitar que los
// componentes tengan que conocer detalles de CSS o metadata del cliente.
export const applyClientSetup = () => {
  const { branding } = CLIENT_SETUP;
  const { theme, metadata } = branding;
  const rootStyle = document.documentElement.style;

  rootStyle.setProperty('--primary-color', theme.primaryColor);
  rootStyle.setProperty('--primary-color-hover', theme.primaryColorHover);
  rootStyle.setProperty('--background-hover-color', theme.backgroundHoverColor);

  document.title = metadata.title || branding.name;
  setMetaContent('meta[name="description"]', metadata.description);
  setMetaContent('meta[name="theme-color"]', metadata.themeColor);
  setMetaContent('meta[name="apple-mobile-web-app-title"]', branding.name);
  setLinkHref('link[rel="icon"]', branding.favicon);
  setLinkHref('link[rel="apple-touch-icon"]', branding.appleTouchIcon || branding.favicon);
};

export default CLIENT_SETUP;

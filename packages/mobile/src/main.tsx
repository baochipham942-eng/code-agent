import { createRoot } from 'react-dom/client';
import { MobileRoot } from './app/MobileRoot';
import { capacitorPorts } from './platform/capacitor';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('MOBILE_ROOT_MISSING');
createRoot(root).render(<MobileRoot ports={capacitorPorts} fixtures={__FIXTURES__} />);

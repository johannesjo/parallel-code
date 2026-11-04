// The desktop Parallel Code look's faces; see src/App.tsx.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/sora/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@xterm/xterm/css/xterm.css';
import './mobile.css';
import { render } from 'solid-js/web';
import { App } from './App';

render(() => <App />, document.getElementById('root') as HTMLElement);

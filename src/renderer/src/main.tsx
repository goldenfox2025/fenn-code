import { createRoot } from 'react-dom/client'
import { App } from './App'
import { useApp } from './store'
import './tokens.css'
import './styles.css'

document.documentElement.classList.add(window.fenn.platform === 'darwin' ? 'mac' : 'not-mac')
void useApp.getState().init()
createRoot(document.getElementById('root')!).render(<App />)

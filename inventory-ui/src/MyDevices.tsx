import 'shell/tokens.css'
import MyDevicesPage from './pages/MyDevicesPage'

/**
 * MyDevices — the remote's second exposed entry, `./MyDevices` (vite.config.ts
 * `exposes`), mounted by the shell at the UNGATED `/devices` route (ADR-0045).
 * Every signed-in user reaches it whether or not they hold `inventory:access`,
 * so it renders the page directly: no inner router, no capability hook and no
 * `/scope` call (T31 fills the page). As with `App`, it must not import this
 * package's own `index.css`.
 */
export default function MyDevices() {
  return <MyDevicesPage />
}

import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { SessionProvider, useSessionContext } from "./context/SessionContext";
import { ConnectedPage } from "./pages/ConnectedPage";
import { ExpiredPage } from "./pages/ExpiredPage";
import { HomePage } from "./pages/HomePage";
import { JoinPage } from "./pages/JoinPage";
import { WaitingPage } from "./pages/WaitingPage";

function AppFrame() {
  const { device, hardResetApp, resetVersion } = useSessionContext();

  return (
    <div className="app-shell">
      <div className="app-container">
        <header className="app-header" aria-label="Kleepee header">
          <a className="text-lg font-semibold text-kleepee-espresso" href="/">
            Kleepee
          </a>
          <div className="device-badge" title={device.deviceName}>
            {device.deviceName}
          </div>
        </header>

        <Routes key={resetVersion}>
          <Route path="/" element={<HomePage />} />
          <Route path="/waiting" element={<WaitingPage />} />
          <Route path="/j/:sessionId" element={<JoinPage />} />
          <Route path="/connected" element={<ConnectedPage />} />
          <Route path="/expired" element={<ExpiredPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>

        <footer className="app-footer flex-col items-center gap-2">
          <button className="btn-reset" type="button" aria-describedby="reset-description" onClick={hardResetApp}>
            Reset app
          </button>
          <p id="reset-description" className="max-w-sm text-center text-xs leading-5 text-kleepee-muted">
            Leaves this session and clears this tab’s text and files, plus saved recent sessions.
          </p>
        </footer>
      </div>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <AppFrame />
      </SessionProvider>
    </BrowserRouter>
  );
}

export default App;

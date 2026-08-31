import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import ApplicationsPage from './pages/ApplicationsPage.jsx';
import AnalyticsPage from './pages/AnalyticsPage.jsx';
import CompanyPeek from './components/CompanyPeek.jsx';

const TABS = [
  { to: '/applications', label: 'Applications' },
  { to: '/analytics', label: 'Analytics' },
];

export default function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <header className="app-head">
          <h1>Resume Tracker</h1>
          <nav className="tabs">
            {TABS.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                className={({ isActive }) => `tab${isActive ? ' active' : ''}`}
              >
                {tab.label}
              </NavLink>
            ))}
          </nav>
        </header>

        <Routes>
          <Route path="/" element={<Navigate to="/applications" replace />} />
          <Route path="/applications" element={<ApplicationsPage />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="*" element={<Navigate to="/applications" replace />} />
        </Routes>

        <CompanyPeek />
      </div>
    </BrowserRouter>
  );
}

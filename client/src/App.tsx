import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { MantineProvider, createTheme } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import '@mantine/dropzone/styles.css';
import './i18n';

import { AuthProvider } from './contexts/AuthContext';
import { ImportProgressProvider } from './contexts/ImportProgressContext';
import ImportProgressBar from './components/ImportProgressBar';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import LeadsPage from './pages/LeadsPage';
import ImportPage from './pages/ImportPage';
import CompanyDetailPage from './pages/CompanyDetailPage';
import DashboardPage from './pages/DashboardPage';
import PeoplePage from './pages/PeoplePage';
import PersonDetailPage from './pages/PersonDetailPage';
import PipelinePage from './pages/PipelinePage';
import AdminPage from './pages/AdminPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30 * 1000, // 30 seconds
      refetchOnWindowFocus: false,
    },
  },
});

const theme = createTheme({
  primaryColor: 'violet',
  fontFamily:
    'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  headings: {
    fontFamily:
      'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  radius: {
    xs: '4px',
    sm: '6px',
    md: '8px',
    lg: '12px',
    xl: '16px',
  },
  defaultRadius: 'md',
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <MantineProvider theme={theme} defaultColorScheme="light">
        <Notifications position="top-right" />
        <ModalsProvider>
          <ImportProgressProvider>
            <ImportProgressBar />
          <BrowserRouter>
            <AuthProvider>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route element={<Layout />}>
                  <Route path="/" element={<Navigate to="/dashboard" replace />} />
                  <Route path="/dashboard" element={<DashboardPage />} />
                  <Route path="/companies" element={<LeadsPage />} />
                  <Route path="/companies/:id" element={<CompanyDetailPage />} />
                  <Route path="/people" element={<PeoplePage />} />
                  <Route path="/people/:id" element={<PersonDetailPage />} />
                  <Route path="/pipeline" element={<PipelinePage />} />
                  <Route path="/import" element={<ImportPage />} />
                  <Route path="/admin" element={<AdminPage />} />
                  <Route path="/admin/:tab" element={<AdminPage />} />
                </Route>
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Routes>
            </AuthProvider>
          </BrowserRouter>
          </ImportProgressProvider>
        </ModalsProvider>
      </MantineProvider>
    </QueryClientProvider>
  );
}

export default App;

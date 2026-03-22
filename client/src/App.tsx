import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { MantineProvider, createTheme } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { ModalsProvider } from '@mantine/modals';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Center, Loader } from '@mantine/core';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import '@mantine/dropzone/styles.css';
import './i18n';

import { AuthProvider } from './contexts/AuthContext';
import { StagesProvider } from './contexts/StagesContext';
import { ImportProgressProvider } from './contexts/ImportProgressContext';
import ImportProgressBar from './components/ImportProgressBar';
import ErrorBoundary from './components/ErrorBoundary';
import Layout from './components/Layout';

const LoginPage = lazy(() => import('./pages/LoginPage'));
const LeadsPage = lazy(() => import('./pages/LeadsPage'));
const ImportPage = lazy(() => import('./pages/ImportPage'));
const CompanyDetailPage = lazy(() => import('./pages/CompanyDetailPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const PeoplePage = lazy(() => import('./pages/PeoplePage'));
const PersonDetailPage = lazy(() => import('./pages/PersonDetailPage'));
const PipelinePage = lazy(() => import('./pages/PipelinePage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
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
            <ErrorBoundary>
            <AuthProvider>
              <StagesProvider>
              <Suspense fallback={<Center h="100vh"><Loader /></Center>}>
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
              </Suspense>
              </StagesProvider>
            </AuthProvider>
            </ErrorBoundary>
          </BrowserRouter>
          </ImportProgressProvider>
        </ModalsProvider>
      </MantineProvider>
    </QueryClientProvider>
  );
}

export default App;

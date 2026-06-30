import React from 'react';
import Dashboard from '../components/Dashboard';

export default function DashboardPage({ currentUser, isDevMode, showToast }) {
  if (!currentUser) {
    return null; // Will be handled by ProtectedRoute redirection in App.jsx
  }

  return (
    <div className="flex-1 min-h-[80vh] bg-zinc-950">
      <Dashboard 
        currentUser={currentUser} 
        isDevMode={isDevMode} 
        showToast={showToast} 
      />
    </div>
  );
}

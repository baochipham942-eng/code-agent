// ============================================================================
// User Menu - User dropdown with account and sync options
// ============================================================================

import React, { useState, useRef, useEffect } from 'react';
import { useAuthStore } from '../stores/authStore';
import {
  User,
  LogOut,
  LogIn,
} from 'lucide-react';

export const UserMenu: React.FC = () => {
  const {
    user,
    isAuthenticated,
    signOut,
    setShowAuthModal,
  } = useAuthStore();

  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Not logged in - show login button
  if (!isAuthenticated || !user) {
    return (
      <button
        onClick={() => setShowAuthModal(true)}
        className="window-no-drag flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
      >
        <LogIn className="w-4 h-4" />
        登录
      </button>
    );
  }

  return (
    <div className="relative" ref={menuRef}>
      {/* User button */}
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="window-no-drag flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-hover transition-colors"
      >
        {user.avatarUrl ? (
          <img
            src={user.avatarUrl}
            alt=""
            className="w-6 h-6 rounded-full object-cover"
          />
        ) : (
          <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center">
            <User className="w-4 h-4 text-white" />
          </div>
        )}
        <span className="text-sm text-text-secondary max-w-24 truncate">
          {user.nickname || user.email?.split('@')[0]}
        </span>
      </button>

      {/* Dropdown menu */}
      {showMenu && (
        <div className="absolute right-0 top-full mt-2 w-48 bg-deep border border-border-default rounded-lg shadow-xl z-50">
          {/* Logout action */}
          <div className="p-2">
            <button
              onClick={() => {
                signOut();
                setShowMenu(false);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-hover rounded-lg transition-colors"
            >
              <LogOut className="w-4 h-4" />
              退出登录
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

import React from 'react';

export const RolePersonaTab: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <section data-testid="role-detail-persona-tab">{children}</section>
);

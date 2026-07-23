import React from 'react';

export const RoleRecordsTab: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <section data-testid="role-detail-records-tab" className="space-y-5">{children}</section>
);

import React from 'react';

export const RoleEquipmentTab: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <section data-testid="role-detail-equipment-tab">{children}</section>
);

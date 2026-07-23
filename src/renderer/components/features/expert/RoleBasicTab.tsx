import React from 'react';

export const RoleBasicTab: React.FC<{ action: React.ReactNode; editor: React.ReactNode; notice: React.ReactNode }> = ({ action, editor, notice }) => (
  <section data-testid="role-detail-basic-tab" className="space-y-4">
    <div className="flex justify-end">{action}</div>
    {editor}
    {notice}
  </section>
);

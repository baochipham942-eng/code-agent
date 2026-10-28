// ============================================================================
// CronTemplateRoleField —— 模板填参里的「交给哪位角色」（可选）。
// 选项来自 rolesClient.listRoles（持久化角色）。空值 = 不绑定，生成结果与未选时相同。
// ============================================================================

import React, { useEffect, useState } from 'react';
import type { RolePanelEntry } from '@shared/contract/roleAssets';
import { FormField } from '../../composites/FormField';
import { Select } from '../../primitives/Select';
import { useI18n } from '../../../hooks/useI18n';
import { listRoles } from '../../../services/rolesClient';

interface CronTemplateRoleFieldProps {
  value: string;
  onChange: (roleId: string) => void;
}

export const CronTemplateRoleField: React.FC<CronTemplateRoleFieldProps> = ({ value, onChange }) => {
  const { t } = useI18n();
  const cc = t.cronCenter;
  const [roles, setRoles] = useState<RolePanelEntry[]>([]);

  useEffect(() => {
    let active = true;
    listRoles()
      .then((entries) => {
        if (active) setRoles(entries);
      })
      .catch(() => {
        if (active) setRoles([]);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <FormField label={cc.templateRoleLabel} htmlFor="cron-template-role">
      <Select
        id="cron-template-role"
        data-testid="cron-template-role-select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        options={[
          { value: '', label: cc.templateRoleNone },
          ...roles.map((role) => ({
            value: role.roleId,
            label: role.displayName || role.roleId,
          })),
        ]}
      />
    </FormField>
  );
};

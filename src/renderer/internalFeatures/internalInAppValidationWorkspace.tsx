import React from 'react';

export const InAppValidationWorkspace = React.lazy(() => (
  import('../components/features/inAppValidation/InAppValidationWorkspace')
    .then(({ InAppValidationWorkspace: defaultExport }) => ({ default: defaultExport }))
));

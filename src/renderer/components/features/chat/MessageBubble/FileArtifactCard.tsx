import React, { useMemo } from 'react';
import type { TurnArtifactOwnershipItem } from '@shared/contract/turnTimeline';
import { buildTurnArtifactDeliverableCards } from '../../../../utils/deliverables';
import { DeliverableCardList } from './DeliverableCardList';

interface Props {
  items: TurnArtifactOwnershipItem[];
}

export const FileArtifactCard: React.FC<Props> = ({ items }) => {
  const cards = useMemo(() => buildTurnArtifactDeliverableCards(items), [items]);
  return <DeliverableCardList cards={cards} className="" />;
};

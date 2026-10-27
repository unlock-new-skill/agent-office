import type { ReactNode } from 'react';
import { SEAT_STATUS_LABEL, type SeatStatus } from '../state/office-store.js';

export function StatusDot({ status }: { status: SeatStatus }): ReactNode {
  return <span className={`status-dot status-${status}`} title={SEAT_STATUS_LABEL[status]} aria-label={SEAT_STATUS_LABEL[status]} role="img" />;
}

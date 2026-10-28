import type { Database } from '../db/database.js';
import type { CollabEvent, Department, Seat, SeatHandoff } from '../../shared/contracts.js';
import { HandoffService } from './handoff-service.js';
import { PermissionService } from './permission-service.js';
import { MessageService, type ChannelSummary } from './message-service.js';
import { OrgService } from './org-service.js';
import { TaskService } from './task-service.js';
import { WakeService } from './wake-service.js';

export type OfficeOptions = { maxAutoWakes: number; emit: (event: CollabEvent) => void; remoteApproval?: boolean };
/** handoff = the seat's raw note; handoffBrief = note + open tasks + unread, ready to inject into a session's context. */
export type WhoAmI = { agentId: string; seat: Seat | null; department: Department | null; channels: ChannelSummary[]; handoff: SeatHandoff | null; handoffBrief: string | null };
export type Office = { org: OrgService; messages: MessageService; wake: WakeService; tasks: TaskService; handoffs: HandoffService; permissions: PermissionService; whoami: (agentId: string, options?: { afterCompaction?: boolean }) => WhoAmI; close: () => void };

/** Wires the collaboration services around one database and one realtime emitter. */
export const createOffice = (db: Database, options: OfficeOptions): Office => {
  const org = new OrgService(db, options.emit, options.maxAutoWakes);
  let wake: WakeService | null = null;
  const messages = new MessageService(db, org, options.emit, message => wake?.onPosted(message), () => wake?.notify());
  wake = new WakeService(db, org, messages, options.maxAutoWakes);
  const wakeService = wake; org.onMutated = () => wakeService.notify();
  const tasks = new TaskService(db, org, messages, options.emit);
  const handoffs = new HandoffService(db, org, messages);
  const permissions = new PermissionService(db, org, options.emit, options.remoteApproval ?? false);
  const whoami = (agentId: string, options: { afterCompaction?: boolean } = {}): WhoAmI => {
    const seat = org.seatForAgent(agentId);
    if (!seat) return { agentId, seat, department: null, channels: [], handoff: null, handoffBrief: null };
    const self = { kind: 'seat', seatId: seat.id } as const;
    return { agentId, seat, department: org.department(seat.departmentId), channels: messages.channelsForSeat(seat.id), handoff: handoffs.get(self, seat.id), handoffBrief: handoffs.brief(seat.id, options) };
  };
  return { org, messages, wake: wakeService, tasks, handoffs, permissions, whoami, close: () => { wakeService.close(); permissions.close(); } };
};

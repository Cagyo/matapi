export type QueuedEventPayload = Record<string, unknown> | null;

export interface NewQueuedEvent {
  sensorId: string | null;
  type: string;
  payload: QueuedEventPayload;
  createdAt: Date;
}

export interface QueuedEvent {
  id: number;
  sensorId: string | null;
  type: string;
  payload: QueuedEventPayload;
  createdAt: Date | null;
}
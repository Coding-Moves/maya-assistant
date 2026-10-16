import { z } from 'zod';

const taskType = z.enum([
  'quiz',
  'assignment',
  'exam',
  'announcement',
  'venue_change',
  'class',
  'other',
]);
const messageRef = z.number().int().positive();

const create = z.object({
  op: z.literal('create'),
  subject: z.string().nullable(),
  type: taskType,
  title: z.string().min(1),
  details: z.string().nullable(),
  due_at: z.string().nullable(),
  source_msg_ref: messageRef,
});

const update = z.object({
  op: z.literal('update'),
  task_id: z.number().int().positive(),
  subject: z.string().nullable().optional(),
  type: taskType.optional(),
  title: z.string().min(1).optional(),
  details: z.string().nullable().optional(),
  due_at: z.string().nullable().optional(),
  source_msg_ref: messageRef,
});

const cancel = z.object({
  op: z.literal('cancel'),
  task_id: z.number().int().positive(),
  reason: z.string().optional(),
  source_msg_ref: messageRef,
});

export const extractionSchema = z.object({
  actions: z.array(z.discriminatedUnion('op', [create, update, cancel])),
});

export type ExtractionResult = z.infer<typeof extractionSchema>;

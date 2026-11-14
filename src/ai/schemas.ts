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

const ownerTaskFields = z.object({
  subject: z.string().max(80).nullable(),
  type: taskType,
  title: z.string().trim().min(1).max(180),
  details: z.string().max(1_000).nullable(),
  due_at: z.string().datetime({ offset: true }).nullable(),
});

export const ownerTaskUpdateSchema = z.object({
  actions: z.array(z.discriminatedUnion('op', [
    ownerTaskFields.extend({ op: z.literal('create') }),
    z.object({ op: z.literal('update'), subject: z.string().max(80).nullable().optional(), type: taskType.optional(),
      title: z.string().trim().min(1).max(180), details: z.string().max(1_000).nullable().optional(),
      due_at: z.string().datetime({ offset: true }).nullable().optional() }),
    z.object({ op: z.literal('cancel'), subject: z.string().max(80).nullable(), title: z.string().trim().min(1).max(180), reason: z.string().max(300).nullable() }),
  ])).max(12),
});
export type OwnerTaskUpdate = z.infer<typeof ownerTaskUpdateSchema>;

// A narrow owner-memory intent. Application code resolves targets and authorizes all writes.
export const memoryIntentSchema = z.object({
  action: z.enum(['none', 'clarify', 'save', 'show', 'list', 'search', 'update', 'replace',
    'archive', 'delete', 'clear', 'complete', 'show_timetable', 'correct_timetable']),
  lifecycle: z.enum(['permanent', 'semi', 'temporary']).nullable(),
  category: z.string().max(60).nullable(),
  title: z.string().max(160).nullable(),
  body: z.string().max(4_000).nullable(),
  date: z.string().nullable(),
  target: z.string().max(160).nullable(),
  target_id: z.number().int().positive().nullable(),
  page: z.number().int().positive().nullable(),
  entry: z.number().int().positive().nullable(),
  field: z.enum(['day_of_week', 'start_local', 'end_local', 'subject', 'location', 'teacher']).nullable(),
  value: z.string().max(160).nullable(),
  question: z.string().max(250).nullable(),
});
export type MemoryIntent = z.infer<typeof memoryIntentSchema>;

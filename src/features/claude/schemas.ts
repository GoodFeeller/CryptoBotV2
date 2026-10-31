// [REVIEW i-code#23] Схемы ответа: одни и те же для API и сессий Claude Code. Поля плоские и nullable, а не вариант «вход/нет»:
// такую форму проще всего получать структурированным выводом. Полноту ответа при enter=true проверяет советник.
import { z } from 'zod'

export const EntryResponseSchema = z.object({
  enter: z.boolean(),
  side: z.enum(['long', 'short']).nullable(),
  entryPrice: z.number().nullable(),
  leverage: z.number().nullable(),
  notionalPct: z.number().nullable(),
  stop: z.number().nullable(),
  take: z.number().nullable(),
  reason: z.string(),
})

export const ReviewResponseSchema = z.object({
  newStop: z.number().nullable(),
  newTake: z.number().nullable(),
  closeNow: z.boolean(),
  reason: z.string(),
})

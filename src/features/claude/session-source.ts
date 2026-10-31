// [REVIEW i-code#28] Бэктест через сессии Claude Code: файловый обмен вместо платного API. Весь период раздать сразу нельзя, потому
// что запас потери и разборы зависят от прошлых сделок, поэтому прогон идёт шагами: дошёл до запросов без ответа, записал их,
// остановился. Запись идёт без исключения, чтобы все запросы одного шага попали в файлы вместе.
// Если в одном шаге две монеты, запас второй зависит от ответа по первой: её запрос после ответа может измениться и прийти снова.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { DecisionRequest, DecisionSource, SourceAnswer } from './decision-advisor.js'
import { EntryResponseSchema, ReviewResponseSchema } from './schemas.js'

export class SessionDecisionSource implements DecisionSource {
  private readonly pendingDir: string
  private readonly answersDir: string
  private readonly pending = new Set<string>()

  constructor(
    dir: string,
    private readonly promptVersion: string,
  ) {
    this.pendingDir = join(dir, 'pending')
    this.answersDir = join(dir, 'answers')
    mkdirSync(this.pendingDir, { recursive: true })
    mkdirSync(this.answersDir, { recursive: true })
  }

  async answer(request: DecisionRequest): Promise<SourceAnswer> {
    const key = createHash('sha256').update(JSON.stringify(['session', this.promptVersion, request.body])).digest('hex')
    const file = `${key}.json`
    const answerPath = join(this.answersDir, file)
    const pendingPath = join(this.pendingDir, file)

    if (!existsSync(answerPath)) {
      const schema = request.kind === 'entry' ? EntryResponseSchema : ReviewResponseSchema
      writeFileSync(pendingPath, JSON.stringify({ ...request, responseSchema: z.toJSONSchema(schema) }, null, 2))
      this.pending.add(key)
      return { status: 'pending' }
    }

    rmSync(pendingPath, { force: true })
    try {
      return { status: 'answered', raw: JSON.parse(readFileSync(answerPath, 'utf8')) }
    } catch {
      return { status: 'failed', message: `повреждён файл ответа ${file}`, refusal: false }
    }
  }

  pendingCount(): number {
    return this.pending.size
  }

  /** Убирает запросы прошлого запуска: сессии должны видеть только актуальные. */
  clearPending(): void {
    for (const file of readdirSync(this.pendingDir)) rmSync(join(this.pendingDir, file))
    this.pending.clear()
  }

  pendingDirectory(): string {
    return this.pendingDir
  }
}

// Отвечает на запросы сессионного бэктеста сессиями Claude Code вместо платного API. Каждая сессия запускается в пустой временной
// папке без инструментов, MCP и настроек проекта: она видит только системный промпт и обезличенный запрос и не может прочитать
// свечи из data, поэтому заглянуть в будущее не может. Ответы за модель не придумываются: при сбое команда останавливается.
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { z } from 'zod'
import { EntryResponseSchema, ReviewResponseSchema } from '../features/claude/schemas.js'

const ATTEMPTS = 2

export interface SessionInput {
  system: string
  /** Обезличенное тело запроса в JSON. */
  prompt: string
  /** JSON-схема ответа. */
  schema: object
}

/** Запускает одну сессию и отдаёт её структурированный ответ. */
export type ClaudeRunner = (input: SessionInput) => Promise<unknown>

interface PendingFile {
  kind: 'entry' | 'review'
  system: string
  body: object
  responseSchema: object
}

/** Отвечает на все запросы из dir/pending и пишет ответы в dir/answers под теми же именами. Возвращает число ответов. */
export async function answerPending(dir: string, runner: ClaudeRunner, options: { concurrency: number }): Promise<number> {
  const files = readdirSync(join(dir, 'pending')).filter((file) => file.endsWith('.json'))
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const file = files[next++]!
      const request = JSON.parse(readFileSync(join(dir, 'pending', file), 'utf8')) as PendingFile
      const answer = await askValid(file, request, runner)
      writeFileSync(join(dir, 'answers', file), JSON.stringify(answer, null, 2))
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, files.length) }, worker))
  return files.length
}

async function askValid(file: string, request: PendingFile, runner: ClaudeRunner): Promise<unknown> {
  const schema: z.ZodType = request.kind === 'entry' ? EntryResponseSchema : ReviewResponseSchema
  let problem = ''
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const parsed = schema.safeParse(await runner({ system: request.system, prompt: JSON.stringify(request.body), schema: request.responseSchema }))
    if (parsed.success) return parsed.data
    problem = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
  }
  throw new Error(`Сессия дважды ответила не по схеме на ${file}: ${problem}`)
}

/** Настоящий запуск: claude -p в пустой папке, без инструментов, MCP и настроек. */
export function createCliRunner(options: { model: string; command?: string }): ClaudeRunner {
  return (input) =>
    new Promise((resolve, reject) => {
      const cwd = mkdtempSync(join(tmpdir(), 'cryptobot-session-'))
      const args = [
        '-p',
        '--output-format', 'json',
        '--model', options.model,
        '--tools', '',
        '--strict-mcp-config',
        '--setting-sources', '',
        '--no-session-persistence',
        '--system-prompt', input.system,
        '--json-schema', JSON.stringify(cliSchema(input.schema)),
      ]
      const child = spawn(options.command ?? 'claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk) => (out += chunk))
      child.stderr.on('data', (chunk) => (err += chunk))
      child.on('error', (error) => finish(() => reject(error)))
      child.on('close', (code) =>
        finish(() => {
          if (code !== 0) return reject(new Error(cliFailure(code, out, err)))
          try {
            resolve(structuredOutput(JSON.parse(out)))
          } catch (error) {
            reject(new Error(`Не разобрал ответ claude: ${(error as Error).message}; ${out.slice(0, 500)}`))
          }
        }),
      )
      child.stdin.end(input.prompt)
      const finish = (done: () => void) => {
        rmSync(cwd, { recursive: true, force: true })
        done()
      }
    })
}

/** Причина сбоя claude: из поля result его JSON-ответа, иначе из stderr. */
export function cliFailure(code: number | null, out: string, err: string): string {
  let reason = (err || out).trim().slice(0, 500)
  try {
    const parsed = JSON.parse(out) as { result?: unknown }
    if (typeof parsed.result === 'string' && parsed.result) reason = parsed.result
  } catch {
    // не JSON: оставляем stderr или сырой вывод
  }
  return `claude завершился с кодом ${code}: ${reason}`
}

/** claude --json-schema не принимает ключ $schema с черновиком 2020-12, который ставит zod; сама схема от этого не меняется. */
export function cliSchema(schema: object): object {
  const { $schema: _draft, ...rest } = schema as Record<string, unknown>
  return rest
}

/** С --json-schema ответ лежит в structured_output; если его нет, пробуем разобрать текст результата. */
function structuredOutput(result: { is_error?: boolean; structured_output?: unknown; result?: string }): unknown {
  if (result.is_error) throw new Error(`сессия вернула ошибку: ${result.result ?? ''}`)
  if (result.structured_output !== undefined) return result.structured_output
  return JSON.parse(result.result ?? '')
}

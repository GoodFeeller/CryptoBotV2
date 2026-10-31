// dependency-cruiser пока не поддерживает TypeScript 7: с ним он молча не видит .ts файлы и не находит нарушений.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'core-is-independent',
      comment: 'core не зависит ни от проекта, ни от внешних пакетов',
      severity: 'error',
      from: { path: '^src/core/' },
      to: { pathNot: ['^src/core/'] },
    },
    {
      name: 'features-are-isolated',
      comment: 'Фича не импортирует другую фичу, общение только через интерфейсы core',
      severity: 'error',
      from: { path: '^src/features/([^/]+)/' },
      to: { path: '^src/features/', pathNot: '^src/features/$1/' },
    },
    {
      name: 'features-do-not-know-app',
      comment: 'Сборка зависит от фич, но не наоборот',
      severity: 'error',
      from: { path: '^src/features/' },
      to: { path: '^src/app/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
}

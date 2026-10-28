import type { ProjectChangesDto } from './project-changes.dto';

const description =
  'Replace baseRevisionId and fileId with actual IDs from GET /api/projects/:projectId/state. Resource uploadId comes from POST /api/projects/:projectId/uploads. Use a new Idempotency-Key for each new save.';

export const projectChangesExamples = {
  updateText: {
    summary: 'Оновити текст файла',
    description,
    value: {
      baseRevisionId: 1,
      summary: 'Оновлено вступ документа',
      operations: [{ type: 'updateText', fileId: 1, content: '= Документ\nОновлений вступ.' }],
    } satisfies ProjectChangesDto,
  },
  addChapter: {
    summary: 'Додати розділ і підключити його',
    description,
    value: {
      baseRevisionId: 1,
      summary: 'Додано розділ',
      operations: [
        { type: 'createFile', path: 'chapter.typ', content: '== Новий розділ\nТекст розділу.' },
        { type: 'updateText', fileId: 1, content: '= Документ\n#include "chapter.typ"' },
      ],
    } satisfies ProjectChangesDto,
  },
  renameFile: {
    summary: 'Перейменувати або перемістити файл',
    description,
    value: {
      baseRevisionId: 1,
      summary: 'Переміщено головний файл',
      operations: [{ type: 'renameFile', fileId: 1, path: 'src/document.typ' }],
    } satisfies ProjectChangesDto,
  },
  replaceEntrypoint: {
    summary: 'Замінити головний файл',
    description,
    value: {
      baseRevisionId: 1,
      summary: 'Створено новий головний файл',
      operations: [
        { type: 'createFile', path: 'document.typ', content: '= Новий документ' },
        { type: 'setEntrypoint', path: 'document.typ' },
        { type: 'deleteFile', fileId: 1 },
      ],
    } satisfies ProjectChangesDto,
  },
  updateContext: {
    summary: 'Оновити лише контекст',
    description,
    value: {
      baseRevisionId: 1,
      summary: 'Уточнено контекст',
      operations: [
        { type: 'updateContext', content: 'Документ українською мовою для дипломної роботи.' },
      ],
    } satisfies ProjectChangesDto,
  },
  attachResource: {
    summary: 'Додати завантажений ресурс',
    description,
    value: {
      baseRevisionId: 1,
      summary: 'Додано логотип',
      operations: [
        { type: 'attachFile', uploadId: 1, path: 'assets/logo.png' },
        { type: 'updateText', fileId: 1, content: '#image("assets/logo.png")' },
      ],
    } satisfies ProjectChangesDto,
  },
  replaceResource: {
    summary: 'Замінити ресурс зі збереженням ID файла',
    description,
    value: {
      baseRevisionId: 2,
      summary: 'Замінено логотип',
      operations: [{ type: 'replaceFile', fileId: 2, uploadId: 2 }],
    } satisfies ProjectChangesDto,
  },
};

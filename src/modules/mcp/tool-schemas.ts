import { z } from 'zod';
import { MAX_CHANGE_OPERATIONS, MAX_TEXT_BYTES } from '../projects/domain/text-changes';

export const id = z.number().int().min(1).max(2147483647);
export const page = { limit: z.number().int().min(1).max(100).default(20), cursor: id.optional() };
export const project = { projectId: id };
export const revision = { ...project, revisionId: id };
export const proposal = { ...project, proposalId: id };
export const version = z.number().int().min(1).max(100);
const content = z.string().max(MAX_TEXT_BYTES);
const path = z.string().min(1).max(1024);
export const changeBatch = {
  summary: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .regex(/^\P{Cc}+$/u)
    .optional(),
  operations: z
    .array(
      z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('createDirectory'), path }),
        z.strictObject({ type: z.literal('renameDirectory'), path, newPath: path }),
        z.strictObject({ type: z.literal('deleteDirectory'), path }),
        z.strictObject({ type: z.literal('createFile'), path, content }),
        z.strictObject({ type: z.literal('updateText'), fileId: id, content }),
        z.strictObject({ type: z.literal('renameFile'), fileId: id, path }),
        z.strictObject({ type: z.literal('deleteFile'), fileId: id }),
        z.strictObject({ type: z.literal('setEntrypoint'), path }),
        z.strictObject({ type: z.literal('updateContext'), content }),
        z.strictObject({ type: z.literal('attachFile'), uploadId: id, path }),
        z.strictObject({ type: z.literal('replaceFile'), fileId: id, uploadId: id }),
      ]),
    )
    .min(1)
    .max(MAX_CHANGE_OPERATIONS),
};
export const chunk = {
  offset: z.number().int().min(0).max(MAX_TEXT_BYTES).default(0),
  length: z.number().int().min(2).max(32_768).default(16_384),
};
export function textChunk(content: string, offset: number, length: number) {
  const low = (i: number) => (content.charCodeAt(i) & 0xfc00) === 0xdc00;
  const start = Math.min(offset, content.length) - Number(low(offset));
  const end = Math.min(start + length, content.length);
  const boundary = end - Number(low(end));
  return {
    content: content.slice(start, boundary),
    offset: start,
    nextOffset: boundary < content.length ? boundary : null,
    totalLength: content.length,
  };
}

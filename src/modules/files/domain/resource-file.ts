import {
  BadRequestException,
  FileTypeValidator,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';

export const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_ACTIVE_UPLOADS = 400;
export const MAX_ACTIVE_UPLOAD_BYTES = 256 * 1024 * 1024;

export interface UploadedResource {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

const formats = [
  {
    extensions: ['png'],
    mimes: ['image/png', 'image/apng'],
    aliases: [],
  },
  {
    extensions: ['jpg', 'jpeg'],
    mimes: ['image/jpeg'],
    aliases: [],
  },
  {
    extensions: ['gif'],
    mimes: ['image/gif'],
    aliases: [],
  },
  {
    extensions: ['webp'],
    mimes: ['image/webp'],
    aliases: [],
  },
  {
    extensions: ['pdf'],
    mimes: ['application/pdf'],
    aliases: [],
  },
  {
    extensions: ['ttf'],
    mimes: ['font/ttf'],
    aliases: ['application/x-font-ttf', 'application/font-sfnt'],
  },
  {
    extensions: ['otf'],
    mimes: ['font/otf'],
    aliases: ['application/x-font-opentype', 'application/font-sfnt'],
  },
  {
    extensions: ['woff'],
    mimes: ['font/woff'],
    aliases: ['application/font-woff'],
  },
  {
    extensions: ['woff2'],
    mimes: ['font/woff2'],
    aliases: [],
  },
];

export function resourceExtensionMatches(path: string, mediaType: string): boolean {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? '';
  return formats.some(
    (format) => format.extensions.includes(extension) && format.mimes.includes(mediaType),
  );
}

export async function validateResourceFile(
  file: UploadedResource | undefined,
): Promise<{ filename: string; mediaType: string }> {
  if (!file || !Buffer.isBuffer(file.buffer))
    throw new BadRequestException('Attach one file in the multipart field named file');
  const filename = file.originalname.normalize('NFC');
  if (
    !filename ||
    Buffer.byteLength(filename, 'utf8') > 255 ||
    /[\\/:\p{Cc}]/u.test(filename) ||
    filename === '.' ||
    filename === '..' ||
    Buffer.from(filename, 'utf8').toString('utf8') !== filename
  )
    throw new BadRequestException({
      code: 'INVALID_UPLOAD_FILENAME',
      message: 'Use a filename without directories or control characters, up to 255 UTF-8 bytes',
    });
  if (!file.buffer.length) throw new BadRequestException('The uploaded file must not be empty');
  if (file.buffer.length > MAX_RESOURCE_BYTES)
    throw new PayloadTooLargeException('Each resource is limited to 10 MiB');
  const format = formats.find((item) =>
    item.extensions.includes(filename.split('.').at(-1)?.toLowerCase() ?? ''),
  );
  const declared = file.mimetype.toLowerCase();
  const unsupported = () =>
    new UnsupportedMediaTypeException({
      code: 'UNSUPPORTED_RESOURCE_TYPE',
      message:
        'Extension, MIME and bytes must match a supported PNG/JPEG/GIF/WebP/PDF/TTF/OTF/WOFF/WOFF2 resource',
    });
  // Restrict allowed filename formats, then detect the actual type from bytes once.
  if (
    !format ||
    (declared !== 'application/octet-stream' &&
      ![...format.mimes, ...format.aliases].includes(declared))
  )
    throw unsupported();
  const inspected = { buffer: file.buffer, mimetype: declared, size: file.buffer.length };
  const validator = new FileTypeValidator({
    fileType: new RegExp(`^(?:${format.mimes.join('|')})$`),
    overrideMimeType: true,
  });
  if (!(await validator.isValid(inspected))) throw unsupported();
  return { filename, mediaType: inspected.mimetype };
}

export function attachmentDisposition(filename: string): string {
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="download"; filename*=UTF-8''${encoded}`;
}

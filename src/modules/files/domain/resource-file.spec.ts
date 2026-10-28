import { pngResource, pdfResource } from '../../../../test/fixtures/resources';
import {
  attachmentDisposition,
  resourceExtensionMatches,
  validateResourceFile,
} from './resource-file';

it('validates extension, declared MIME and signature without treating generic MIME as authoritative', async () => {
  expect(
    await validateResourceFile({
      originalname: 'Логотип.PNG',
      mimetype: 'application/octet-stream',
      buffer: pngResource,
      size: pngResource.length,
    }),
  ).toEqual({ filename: 'Логотип.PNG', mediaType: 'image/png' });
  expect(
    await validateResourceFile({
      originalname: 'report.pdf',
      mimetype: 'application/pdf',
      buffer: pdfResource,
      size: pdfResource.length,
    }),
  ).toEqual({ filename: 'report.pdf', mediaType: 'application/pdf' });
  for (const [originalname, mimetype, buffer] of [
    ['fake.png', 'image/png', Buffer.from('<html>fake</html>')],
    ['fake.jpg', 'image/jpeg', pngResource],
    ['fake.png', 'application/pdf', pngResource],
    ['image.svg', 'image/svg+xml', Buffer.from('<svg/>')],
    ['file.zip', 'application/zip', Buffer.from('PKfake')],
  ] as const)
    await expect(
      validateResourceFile({ originalname, mimetype, buffer, size: buffer.length }),
    ).rejects.toMatchObject({ status: 415 });
});

it.each(['../logo.png', 'C:\\logo.png', 'dir/logo.png', 'bad\n.png', 'a'.repeat(256) + '.png'])(
  'rejects an unsafe multipart filename: %j',
  async (originalname) => {
    await expect(
      validateResourceFile({
        originalname,
        mimetype: 'image/png',
        buffer: pngResource,
        size: pngResource.length,
      }),
    ).rejects.toMatchObject({ status: 400 });
  },
);

it('keeps resource extensions compatible and encodes Unicode attachment filenames', () => {
  expect(resourceExtensionMatches('assets/photo.JPG', 'image/jpeg')).toBe(true);
  expect(resourceExtensionMatches('assets/photo.png', 'image/jpeg')).toBe(false);
  expect(attachmentDisposition('Логотип.png')).toBe(
    'attachment; filename="download"; filename*=UTF-8\'\'%D0%9B%D0%BE%D0%B3%D0%BE%D1%82%D0%B8%D0%BF.png',
  );
  expect(attachmentDisposition('a"b.png')).not.toContain('a"b');
});

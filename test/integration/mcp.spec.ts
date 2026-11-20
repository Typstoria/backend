import { hasRealTypstRunner, realTypstRunner } from '../fixtures/typst-runner';
import 'dotenv/config';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  auth as oauth,
  Client,
  StreamableHTTPClientTransport,
  type OAuthClientProvider,
} from '@modelcontextprotocol/client';
import { DataSource, In } from 'typeorm';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApplication } from '../../src/bootstrap/configure-application';
import { AppConfigService } from '../../src/config/app-config.service';
import { validateEnvironment } from '../../src/config/environment';
import { mcpScopes } from '../../src/common/actor/access-policy';
import { AccessGrant } from '../../src/modules/access/access-grant.entity';
import { CompileProcessor } from '../../src/modules/compilation/application/compile-processor.service';
import { TypstRunner } from '../../src/modules/compilation/domain/compilation';
import { BlobStorage } from '../../src/modules/files/infrastructure/blob-storage';
import { LocalBlobStorage } from '../../src/modules/files/infrastructure/local-blob-storage';
import { SessionService } from '../../src/modules/identity/application/session.service';
import { hashToken } from '../../src/modules/identity/domain/tokens';
import { User } from '../../src/modules/identity/infrastructure/persistence/entities/user.entity';
import { ProjectsService } from '../../src/modules/projects/application/projects.service';
import type { ProjectCreatedDto } from '../../src/modules/projects/http/projects.dto';
import { pngResource } from '../fixtures/resources';

const redirectUri = 'http://127.0.0.1:53682/callback';
const fakePdf = Buffer.from('%PDF-1.7\nMCP fixture\n%%EOF');

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP address');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

class Browser {
  private readonly cookies = new Map<string, string>();
  async fetch(url: string, options: RequestInit = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    if (this.cookies.size)
      headers.set('cookie', [...this.cookies].map(([k, v]) => k + '=' + v).join('; '));
    const response = await fetch(url, { ...options, headers, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const equals = pair!.indexOf('=');
      const name = pair!.slice(0, equals);
      const value = pair!.slice(equals + 1);
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
    return response;
  }
}

describe('P5 MCP and OAuth integration', () => {
  let app: INestApplication,
    db: DataSource,
    root: string,
    origin: string,
    processor: CompileProcessor;
  let user: User, web: string, project: ProjectCreatedDto, another: ProjectCreatedDto;
  let clients: Client[], accounts: number[];
  const compile = jest.fn<ReturnType<TypstRunner['compile']>, Parameters<TypstRunner['compile']>>();
  const http = () => request(origin);
  const auth = (token: string) => 'Bearer ' + token;
  async function userSession() {
    const email = 'mcp-' + randomUUID() + '@example.test';
    const account = await db.manager.save(User, {
      email,
      normalizedEmail: email,
      emailVerifiedAt: new Date(),
    });
    accounts.push(account.id);
    return {
      account,
      token: (await app.get(SessionService).create(account, 'MCP tests')).accessToken,
    };
  }
  async function createProject(token = web, title = 'MCP document') {
    return (
      await http()
        .post('/api/projects')
        .set('authorization', auth(token))
        .set('Idempotency-Key', randomUUID())
        .send({ title })
        .expect(201)
    ).body as ProjectCreatedDto;
  }
  async function oauthToken(
    scopes: readonly string[] = mcpScopes,
    projectIds = [project.projectId],
  ) {
    const flow = await authorize(scopes.join(' '), projectIds);
    const response = await flow.exchange();
    if (!response.ok)
      throw new Error('OAuth exchange failed: ' + response.status + ' ' + (await response.text()));
    return (await response.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
  }
  async function connect(token: string, legacy = false) {
    const client = new Client(
      { name: 'Typstoria integration client', version: '1.0.0' },
      { versionNegotiation: { mode: legacy ? 'legacy' : { pin: '2026-07-28' } } },
    );
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
        requestInit: { headers: { authorization: auth(token) } },
      }),
    );
    return client;
  }
  const call = (client: Client, name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const p = () => ({ projectId: project.projectId });
  const rev = () => ({ ...p(), revisionId: project.revisionId });
  const current = () =>
    http()
      .get('/api/projects/' + project.projectId + '/state')
      .set('authorization', auth(web))
      .expect(200);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'typstoria-mcp-'));
    const port = await freePort();
    origin = 'http://127.0.0.1:' + port;
    const config = new AppConfigService(
      validateEnvironment({
        ...process.env,
        MCP_PUBLIC_ORIGIN: origin,
        MCP_OAUTH_COOKIE_KEY: randomBytes(32).toString('base64url'),
      }),
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AppConfigService)
      .useValue(config)
      .overrideProvider(BlobStorage)
      .useValue(new LocalBlobStorage({ blobStoragePath: root } as AppConfigService))
      .overrideProvider(TypstRunner)
      .useValue({ compile })
      .compile();
    app = module.createNestApplication({ logger: false, bodyParser: false });
    configureApplication(app);
    await app.listen(port, '127.0.0.1');
    db = app.get(DataSource);
    processor = app.get(CompileProcessor);
  });
  beforeEach(async () => {
    clients = [];
    accounts = [];
    compile.mockReset().mockResolvedValue({
      status: 'succeeded',
      errorCode: null,
      compilerFingerprint: 'a'.repeat(64),
      diagnostics: [],
      pdf: fakePdf,
    });
    const owner = await userSession();
    user = owner.account;
    web = owner.token;
    project = await createProject();
    another = await createProject(web, 'Hidden project');
  });
  afterEach(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
    await db.manager.delete(User, { id: In(accounts) });
  });
  afterAll(async () => {
    await app?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('requires OAuth, limits access to approved projects and lets the owner revoke the connection', async () => {
    const other = await userSession();
    const foreign = await createProject(other.token);
    const tokens = await oauthToken(['projects:read', 'documents:read']);
    const client = await connect(tokens.access_token);
    const list = await call(client, 'list_projects');
    expect(list.structuredContent).toMatchObject({
      items: [{ id: project.projectId }],
      nextCursor: null,
    });
    expect(await call(client, 'list_files', { projectId: another.projectId })).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('RESOURCE_NOT_FOUND') }],
    });
    expect(await call(client, 'list_files', { projectId: foreign.projectId })).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('RESOURCE_NOT_FOUND') }],
    });
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(
      'create_proposal',
    );

    const listing = await http()
      .get('/api/access/connections')
      .set('authorization', auth(web))
      .expect(200)
      .expect('Cache-Control', /no-store/);
    const connection = listing.body.items[0];
    expect(connection).toMatchObject({
      name: 'Test desktop',
      status: 'active',
      projectIds: [project.projectId],
      projects: [{ id: project.projectId, title: 'MCP document' }],
    });
    expect(JSON.stringify(listing.body)).not.toContain(tokens.access_token);
    await http()
      .delete('/api/access/connections/' + connection.id)
      .set('authorization', auth(other.token))
      .expect(404);
    await http()
      .delete('/api/access/connections/' + connection.id)
      .set('authorization', auth(web))
      .expect(204);
    await expect(client.listTools()).rejects.toThrow();

    const capability = await http()
      .get('/api/access/oauth')
      .set('authorization', auth(web))
      .expect(200)
      .expect('Cache-Control', /no-store/);
    expect(capability.body).toEqual({ enabled: true, url: origin + '/mcp' });
    await http().get('/api/access/oauth').expect(401);

    const legacySecret = randomBytes(32).toString('base64url');
    const legacyPat = await db.getRepository(AccessGrant).save({
      userId: user.id,
      authVersion: user.authVersion,
      kind: 'pat',
      name: 'Historical token',
      scopes: ['projects:read'],
      projectIds: [project.projectId],
      secretHash: hashToken(legacySecret),
      oauthGrantId: null,
      clientId: null,
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    });
    const legacyCredential = `tp_pat_${legacyPat.id}.${legacySecret}`;
    await http().post('/mcp').set('authorization', auth(legacyCredential)).send({}).expect(401);
    await http()
      .get('/mcp/artifacts/1/1/pdf')
      .set('authorization', auth(legacyCredential))
      .expect(401);
    await http().post('/api/access/tokens').set('authorization', auth(web)).send({}).expect(404);
    await http().get('/api/access/tokens').set('authorization', auth(web)).expect(404);
    await http().delete('/api/access/tokens/1').set('authorization', auth(web)).expect(404);
  });

  it('uses a real SDK client to read, search, stage PNG, propose, validate, retrieve PDF and require web acceptance', async () => {
    if (hasRealTypstRunner) {
      const runner = realTypstRunner(join(root, 'sandbox'));
      compile.mockImplementation((input, signal) => runner.compile(input, signal));
    }
    const token = await oauthToken();
    const client = await connect(token.access_token);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('create_proposal');
    expect(names).not.toEqual(expect.arrayContaining(['accept_proposal']));
    expect(
      (await call(client, 'read_file', { ...rev(), fileId: project.mainFileId })).structuredContent,
    ).toMatchObject({ content: '', revisionId: project.revisionId });
    const upload = await call(client, 'stage_upload', {
      ...p(),
      filename: 'logo.png',
      mediaType: 'image/png',
      base64: pngResource.toString('base64'),
    });
    expect(upload.isError).not.toBe(true);
    const draft = await call(client, 'create_proposal', {
      ...p(),
      baseRevisionId: project.revisionId,
      operations: [
        {
          type: 'attachFile',
          path: 'assets/logo.png',
          uploadId: (upload.structuredContent as { uploadId: number }).uploadId,
        },
        { type: 'createFile', path: 'chapter.typ', content: '== Розділ\nСлово голка.' },
        {
          type: 'updateText',
          fileId: project.mainFileId,
          content: '= Тест\n#include "chapter.typ"\n#image("assets/logo.png", width: 15pt)',
        },
      ],
    });
    expect(draft.isError).not.toBe(true);
    expect(draft.structuredContent).toMatchObject({ status: 'draft', channel: 'mcp', version: 1 });
    const proposal = draft.structuredContent as { id: number; candidateManifestHash: string };
    expect((await current()).body.revision.id).toBe(project.revisionId);
    const proposed = { ...p(), proposalId: proposal.id };
    expect(
      (await call(client, 'get_proposal', { ...proposed, includeDiff: true })).structuredContent,
    ).toMatchObject({
      diff: { files: expect.arrayContaining([expect.objectContaining({ changes: ['added'] })]) },
    });
    const validation = (
      await call(client, 'validate_proposal', { ...proposed, expectedProposalVersion: 1 })
    ).structuredContent as { id: number; compileJobId: number };
    expect(validation).toMatchObject({ status: 'queued', compileJobId: expect.any(Number) });
    await processor.process(validation.compileJobId);
    const status = await call(client, 'get_proposal_validation', {
      ...proposed,
      validationId: validation.id,
    });
    expect(status.structuredContent).toMatchObject({ status: 'succeeded' });
    const compiled = (
      await call(client, 'get_compile_result', { ...p(), jobId: validation.compileJobId })
    ).structuredContent as { pdfUri: string; pdfDownloadUrl: string };
    expect(compiled).toMatchObject({
      artifactAvailable: true,
      isCurrent: false,
      proposalId: proposal.id,
      pdfUri: expect.any(String),
    });
    const preview = await client.readResource({ uri: compiled.pdfUri });
    expect(compiled.pdfDownloadUrl).toBe(
      origin + `/mcp/artifacts/${project.projectId}/${validation.compileJobId}/pdf`,
    );
    const pdf = await fetch(compiled.pdfDownloadUrl, {
      headers: { authorization: auth(token.access_token) },
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toContain('application/pdf');
    expect(
      (await fetch(compiled.pdfDownloadUrl, { headers: { authorization: auth(web) } })).status,
    ).toBe(401);
    expect(
      (
        await fetch(
          compiled.pdfDownloadUrl.replace(
            '/' + project.projectId + '/',
            '/' + another.projectId + '/',
          ),
          { headers: { authorization: auth(token.access_token) } },
        )
      ).status,
    ).toBe(404);

    expect(preview.contents[0]).toMatchObject({
      mimeType: 'application/pdf',
      blob: expect.stringMatching(/^JVBERi0/),
    });
    await expect(
      client.readResource({
        uri: `typstoria://projects/${another.projectId}/compilations/${validation.compileJobId}/pdf`,
      }),
    ).rejects.toThrow();
    const body = {
      baseRevisionId: project.revisionId,
      expectedProposalVersion: 1,
      validationId: validation.id,
      candidateManifestHash: proposal.candidateManifestHash,
    };
    const url = `/api/projects/${project.projectId}/proposals/${proposal.id}/accept`;
    await http()
      .post(url)
      .set('authorization', auth(token.access_token))
      .set('Idempotency-Key', randomUUID())
      .send(body)
      .expect(401);
    const accepted = await http()
      .post(url)
      .set('authorization', auth(web))
      .set('Idempotency-Key', randomUUID())
      .send(body)
      .expect(201);
    const searched = await call(client, 'search_project', {
      ...p(),
      revisionId: accepted.body.revisionId,
      query: 'голка',
    });
    expect(searched.structuredContent).toMatchObject({
      matches: [{ path: 'chapter.typ', line: 2, column: 7 }],
    });
    expect((await current()).body.revision.id).toBe(accepted.body.revisionId);
    const actor = {
      channel: 'mcp' as const,
      userId: user.id,
      credentialId: (
        await http().get('/api/access/connections').set('authorization', auth(web)).expect(200)
      ).body.items[0].id,
      projectIds: [project.projectId],
      scopes: mcpScopes,
    };
    await expect(
      app.get(ProjectsService).delete(actor, project.projectId, 'mcp'),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('works with the SDK legacy handshake and refuses untrusted origins and web tokens', async () => {
    const token = await oauthToken(['projects:read']);
    const client = await connect(token.access_token, true);
    expect((await call(client, 'list_projects')).structuredContent).toMatchObject({
      items: [{ id: project.projectId }],
    });
    await http()
      .post('/mcp')
      .set('origin', 'https://evil.example')
      .set('authorization', auth(token.access_token))
      .send({})
      .expect(403);
    await http()
      .post('/mcp')
      .set('host', 'evil.example')
      .set('authorization', auth(token.access_token))
      .send({})
      .expect(403);
    await http().post('/mcp').set('authorization', auth(web)).send({}).expect(401);
    const challenge = await http().post('/mcp').send({}).expect(401);
    expect(challenge.headers['www-authenticate']).toContain(
      origin + '/.well-known/oauth-protected-resource/mcp',
    );
  });

  async function authorize(
    scopes = 'projects:read documents:read',
    expectedProjects = [project.projectId],
  ) {
    const discovery = await http().get('/.well-known/oauth-protected-resource/mcp').expect(200);
    expect(discovery.body).toMatchObject({
      resource: origin + '/mcp',
      authorization_servers: [origin + '/oauth'],
    });
    const { body: metadata } = await http()
      .get('/.well-known/oauth-authorization-server/oauth')
      .expect(200);
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    const register = await fetch(metadata.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Test desktop',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    if (!register.ok)
      throw new Error(
        'OAuth registration failed: ' + register.status + ' ' + (await register.text()),
      );
    const { client_id: clientId } = (await register.json()) as { client_id: string };
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = new URL(metadata.authorization_endpoint);
    const params = {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes,
      resource: origin + '/mcp',
      state: 'fixture-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    };
    url.search = new URLSearchParams(params).toString();
    const browser = new Browser();
    const authResponse = await browser.fetch(url.href);
    if (!authResponse.headers.get('location'))
      throw new Error(
        'OAuth start failed: ' +
          authResponse.status +
          ' ' +
          (await authResponse.text()).slice(0, 500),
      );
    const interaction = new URL(authResponse.headers.get('location')!, origin).href;
    expect(interaction).toMatch(new RegExp('^' + origin + '/oauth/interaction/'));
    const page = await browser.fetch(interaction);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await page.text()).toContain('Allow selected projects');
    const details = await browser.fetch(interaction + '/details');
    expect(await details.json()).toMatchObject({ name: 'Test desktop', scopes: scopes.split(' ') });
    const approve = (projectIds: number[], overrideOrigin = origin) =>
      browser.fetch(interaction, {
        method: 'POST',
        headers: {
          origin: overrideOrigin,
          'Content-Type': 'application/json',
          authorization: auth(web),
        },
        body: JSON.stringify({ projectIds }),
      });
    expect((await approve(expectedProjects, 'https://evil.example')).status).toBe(403);
    expect((await approve([2147483647])).status).toBe(404);
    const approved = await approve(expectedProjects);
    if (!approved.ok)
      throw new Error('Consent failed: ' + approved.status + ' ' + (await approved.text()));
    const { resumeUrl } = (await approved.json()) as { resumeUrl: string };
    const resumed = await browser.fetch(new URL(resumeUrl, origin).href);
    const location = resumed.headers.get('location');
    if (!location)
      throw new Error(
        'OAuth resume failed: ' + resumed.status + ' ' + (await resumed.text()).slice(0, 500),
      );
    const callback = new URL(location, origin);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get('state')).toBe('fixture-state');
    expect(callback.searchParams.get('iss')).toBe(origin + '/oauth');
    expect(callback.searchParams.get('code')).toEqual(expect.any(String));
    const exchange = (input: Record<string, string> = {}) =>
      fetch(metadata.token_endpoint, {
        method: 'POST',
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: 'authorization_code',
          code: callback.searchParams.get('code')!,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          resource: origin + '/mcp',
          ...input,
        }),
      });
    const refresh = (token: string, resource = origin + '/mcp') =>
      fetch(metadata.token_endpoint, {
        method: 'POST',
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: 'refresh_token',
          refresh_token: token,
          resource,
        }),
      });
    return { exchange, refresh };
  }

  it('discovers OAuth, binds PKCE and resource, rotates refresh and invalidates reused families', async () => {
    const flow = await authorize();
    expect((await flow.exchange({ code_verifier: 'a'.repeat(43) })).status).toBe(400);
    expect((await flow.exchange({ redirect_uri: 'http://127.0.0.1:53683/callback' })).status).toBe(
      400,
    );
    const exchanged = await flow.exchange();
    if (!exchanged.ok)
      throw new Error('Exchange failed ' + exchanged.status + ' ' + (await exchanged.text()));
    const tokens = (await exchanged.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
    };
    expect(tokens).toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      expires_in: 600,
    });
    expect(tokens.scope.split(' ').sort()).toEqual(['documents:read', 'projects:read']);
    const client = await connect(tokens.access_token);
    expect((await call(client, 'list_projects')).structuredContent).toMatchObject({
      items: [{ id: project.projectId }],
    });
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(
      'create_proposal',
    );
    expect((await flow.exchange()).status).toBe(400);
    expect((await flow.refresh(tokens.refresh_token, origin + '/wrong-resource')).status).toBe(400);
    // A failed resource check may occur after rotation, so verify a fresh family next.
    const next = await authorize();
    const issued = (await (await next.exchange()).json()) as typeof tokens;
    const rotated = await next.refresh(issued.refresh_token);
    if (!rotated.ok)
      throw new Error('Refresh failed ' + rotated.status + ' ' + (await rotated.text()));
    const newer = (await rotated.json()) as typeof tokens;
    expect(newer.refresh_token).not.toBe(issued.refresh_token);
    await connect(newer.access_token);
    expect((await next.refresh(issued.refresh_token)).status).toBe(400);
    await expect(connect(newer.access_token)).rejects.toThrow();
    expect((await next.refresh(newer.refresh_token)).status).toBe(400);
    const connections = await http()
      .get('/api/access/connections')
      .set('authorization', auth(web))
      .expect(200);
    expect(connections.body.items[0]).toMatchObject({
      name: 'Test desktop',
      status: 'revoked',
      projectIds: [project.projectId],
    });
    const serialized = await db.query(
      "SELECT payload::text AS payload FROM mcp_oauth_records WHERE model IN ('AccessToken','RefreshToken','AuthorizationCode')",
    );
    expect(JSON.stringify(serialized)).not.toContain(tokens.access_token);
    expect(JSON.stringify(serialized)).not.toContain(tokens.refresh_token);
  });

  it('connects an SDK OAuth client using discovery and dynamic registration', async () => {
    let authorization: URL | undefined;
    let verifier = '';
    let info: Awaited<ReturnType<OAuthClientProvider['clientInformation']>>;
    let tokens: Awaited<ReturnType<OAuthClientProvider['tokens']>>;
    let discovery: Awaited<ReturnType<NonNullable<OAuthClientProvider['discoveryState']>>>;
    const provider: OAuthClientProvider = {
      redirectUrl: redirectUri,
      clientMetadata: {
        client_name: 'SDK discovery client',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      state: () => 'sdk-fixture-state',
      clientInformation: () => info,
      saveClientInformation: (value) => {
        info = value;
      },
      tokens: () => tokens,
      saveTokens: (value) => {
        tokens = value;
      },
      redirectToAuthorization: (url) => {
        authorization = url;
      },
      saveCodeVerifier: (value) => {
        verifier = value;
      },
      codeVerifier: () => verifier,
      discoveryState: () => discovery,
      saveDiscoveryState: (value) => {
        discovery = value;
      },
    };
    const serverUrl = origin + '/mcp';
    expect(await oauth(provider, { serverUrl, scope: 'projects:read' })).toBe('REDIRECT');
    expect(authorization?.origin).toBe(origin);
    const browser = new Browser();
    const redirect = await browser.fetch(authorization!.href);
    const interaction = new URL(redirect.headers.get('location')!, origin);
    const consent = await browser.fetch(interaction.href, {
      method: 'POST',
      headers: { origin, 'Content-Type': 'application/json', authorization: auth(web) },
      body: JSON.stringify({ projectIds: [project.projectId] }),
    });
    expect(consent.status).toBe(200);
    const { resumeUrl } = (await consent.json()) as { resumeUrl: string };
    const resumed = await browser.fetch(new URL(resumeUrl, origin).href);
    const callback = new URL(resumed.headers.get('location')!, origin);
    expect(callback.searchParams.get('state')).toBe('sdk-fixture-state');
    const authorizationCode = callback.searchParams.get('code')!;
    await expect(
      oauth(provider, { serverUrl, authorizationCode, iss: 'https://untrusted.example/oauth' }),
    ).rejects.toThrow();

    expect(
      await oauth(provider, {
        serverUrl,
        authorizationCode,
        iss: callback.searchParams.get('iss')!,
      }),
    ).toBe('AUTHORIZED');
    const client = new Client({ name: 'OAuth SDK client', version: '1.0.0' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider }),
    );
    expect((await call(client, 'list_projects')).structuredContent).toMatchObject({
      items: [{ id: project.projectId }],
    });
  });

  it('rejects unsafe redirects and makes owner OAuth revocation effective for refresh and MCP', async () => {
    await http()
      .post('/oauth/reg')
      .send({ redirect_uris: ['http://evil.example/callback'], token_endpoint_auth_method: 'none' })
      .expect(400);
    const flow = await authorize('projects:read');
    const tokenResponse = await flow.exchange();
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token: string };
    const client = await connect(tokens.access_token);
    const row = (
      await http().get('/api/access/connections').set('authorization', auth(web)).expect(200)
    ).body.items[0];
    await http()
      .delete('/api/access/connections/' + row.id)
      .set('authorization', auth(web))
      .expect(204);
    await expect(client.listTools()).rejects.toThrow();
    expect((await flow.refresh(tokens.refresh_token)).status).toBe(400);
  });
});

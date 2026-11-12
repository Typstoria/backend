import { CompilationsService } from '../compilation/application/compilations.service';
import { IdParam } from '../../common/ids/parse-id.pipe';
import { attachmentDisposition } from '../files/domain/resource-file';
import type { UserActor } from '../../common/actor/actor';
import { All, Controller, Get, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { Response } from 'express';
import type { ContextRequest } from '../../common/http/request-context';
import { AppConfigService } from '../../config/app-config.service';
import { AccessService } from '../access/access.service';
import { OAuthService } from '../access/oauth.service';
import { Public } from '../identity/http/auth-policy';
import { readBearerToken } from '../identity/http/auth-request';
import { McpToolsService } from './mcp-tools.service';

@ApiExcludeController()
@Public()
@Controller()
export class McpController {
  constructor(
    private readonly config: AppConfigService,
    private readonly access: AccessService,
    private readonly oauth: OAuthService,
    private readonly tools: McpToolsService,
    private readonly compilations: CompilationsService,
  ) {}

  @Get(['.well-known/oauth-protected-resource/mcp', '.well-known/oauth-protected-resource'])
  resource(@Res() res: Response): void {
    if (!this.oauth.resource) {
      res.sendStatus(404);
      return;
    }
    res.json(this.oauth.protectedResourceMetadata());
  }
  @Get('.well-known/oauth-authorization-server/oauth')
  authorization(@Res() res: Response): void {
    const metadata = this.oauth.authorizationMetadata();
    if (!metadata) {
      res.sendStatus(404);
      return;
    }
    res.json(metadata);
  }

  @All('mcp')
  async handle(@Req() req: ContextRequest, @Res() res: Response): Promise<void> {
    const actor = await this.authenticate(req, res);
    if (!actor) return;
    const handler = createMcpHandler(() => this.tools.server(actor, req.requestId!), {
      maxRequestBodySize: 8 * 1024 * 1024,
    });
    try {
      await toNodeHandler(handler, { maxRequestBodySize: 8 * 1024 * 1024 })(req, res, req.body);
    } finally {
      await handler.close();
    }
  }

  @Get('mcp/artifacts/:projectId/:jobId/pdf')
  async download(
    @Req() req: ContextRequest,
    @Res() res: Response,
    @IdParam('projectId') projectId: number,
    @IdParam('jobId') jobId: number,
  ): Promise<void> {
    const actor = await this.authenticate(req, res);
    if (!actor) return;
    const pdf = await this.compilations.pdf(actor, projectId, jobId);
    res.setHeader('Content-Disposition', attachmentDisposition(`compilation-${jobId}.pdf`));
    res.type('application/pdf').send(pdf);
  }

  private async authenticate(req: ContextRequest, res: Response): Promise<UserActor | undefined> {
    const origin = this.config.mcpOrigin;
    if (!origin) throw new ServiceUnavailableException('MCP public origin is not configured');
    res.setHeader('Cache-Control', 'no-store');
    const host = req.get('host')?.toLowerCase();
    const browserOrigin = req.get('origin');
    if (
      host !== new URL(origin).host ||
      (browserOrigin &&
        browserOrigin !== origin &&
        !this.config.corsOrigins.includes(browserOrigin))
    ) {
      res.status(403).json({ error: 'origin_or_host_denied' });
      return;
    }
    const token = readBearerToken(req);
    const actor =
      token &&
      (token.startsWith('tp_pat_')
        ? await this.access.resolvePat(token)
        : await this.oauth.resolve(token));
    if (!actor) {
      const error = token ? 'error="invalid_token", ' : '';
      res.setHeader(
        'WWW-Authenticate',
        `Bearer ${error}resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      );
      res.status(401).json({ error: token ? 'invalid_token' : 'authentication_required' });
      return;
    }
    return actor;
  }
}

import { Tools } from 'librechat-data-provider';
import { formatToolContent } from '../parsers';
import type * as t from '../types';

describe('formatToolContent', () => {
  describe('unrecognized providers', () => {
    it('should return string for unrecognized provider', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          { type: 'text', text: 'Hello world' },
          { type: 'text', text: 'Another text' },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'unknown' as t.Provider);
      expect(content).toBe('Hello world\n\nAnother text');
      expect(artifacts).toBeUndefined();
    });

    it('should return "(No response)" for empty content with unrecognized provider', () => {
      const result: t.MCPToolCallResponse = { content: [] };
      const [content, artifacts] = formatToolContent(result, 'unknown' as t.Provider);
      expect(content).toBe('(No response)');
      expect(artifacts).toBeUndefined();
    });

    it('should return "(No response)" for undefined result with unrecognized provider', () => {
      const result: t.MCPToolCallResponse = undefined;
      const [content, artifacts] = formatToolContent(result, 'unknown' as t.Provider);
      expect(content).toBe('(No response)');
      expect(artifacts).toBeUndefined();
    });

    it('should preserve the image payload in the string for unrecognized providers', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'iVBORw0KGgoAAAA...', mimeType: 'image/png' }],
      };

      const [content, artifacts] = formatToolContent(result, 'unknown' as t.Provider);

      expect(artifacts).toBeUndefined();
      expect(content).toContain('iVBORw0KGgoAAAA...');
      expect(content).toContain('image/png');
    });
  });

  describe('recognized providers', () => {
    const allProviders: t.Provider[] = [
      'google',
      'anthropic',
      'openai',
      'azureopenai',
      'openrouter',
      'xai',
      'deepseek',
      'ollama',
      'bedrock',
    ];

    allProviders.forEach((provider) => {
      describe(`${provider} provider`, () => {
        it('should format text content as string', () => {
          const result: t.MCPToolCallResponse = {
            content: [
              { type: 'text', text: 'First text' },
              { type: 'text', text: 'Second text' },
            ],
          };

          const [content, artifacts] = formatToolContent(result, provider);
          expect(content).toBe('First text\n\nSecond text');
          expect(artifacts).toBeUndefined();
        });

        it('should extract images to artifacts and keep text as string', () => {
          const result: t.MCPToolCallResponse = {
            content: [
              { type: 'text', text: 'Before image' },
              { type: 'image', data: 'base64data', mimeType: 'image/png' },
              { type: 'text', text: 'After image' },
            ],
          };

          const [content, artifacts] = formatToolContent(result, provider);
          expect(content).toBe('Before image\n\nAfter image');
          expect(artifacts).toEqual({
            content: [
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,base64data' },
              },
            ],
          });
        });

        it('should handle empty content', () => {
          const result: t.MCPToolCallResponse = { content: [] };
          const [content, artifacts] = formatToolContent(result, provider);
          expect(content).toBe('(No response)');
          expect(artifacts).toBeUndefined();
        });
      });
    });
  });

  describe('image handling', () => {
    const originalMaxImageBytes = process.env.MCP_IMAGE_DATA_MAX_BYTES;

    afterEach(() => {
      if (originalMaxImageBytes === undefined) {
        delete process.env.MCP_IMAGE_DATA_MAX_BYTES;
        return;
      }
      process.env.MCP_IMAGE_DATA_MAX_BYTES = originalMaxImageBytes;
    });

    it('should handle images with http URLs', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'https://example.com/image.png', mimeType: 'image/png' }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');
      expect(content).toBe('');
      expect(artifacts).toEqual({
        content: [
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/image.png' },
          },
        ],
      });
    });

    it('should handle images with base64 data', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'iVBORw0KGgoAAAA...', mimeType: 'image/png' }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');
      expect(content).toBe('');
      expect(artifacts).toEqual({
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAA...' },
          },
        ],
      });
    });

    it('should return empty string for image-only content when artifacts exist', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'base64data', mimeType: 'image/png' }],
      };
      const [content, artifacts] = formatToolContent(result, 'anthropic');
      expect(content).toBe('');
      expect(artifacts).toBeDefined();
      expect(artifacts?.content).toHaveLength(1);
    });

    it('should handle multiple images without text', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          { type: 'image', data: 'https://example.com/a.png', mimeType: 'image/png' },
          { type: 'image', data: 'https://example.com/b.jpg', mimeType: 'image/jpeg' },
        ],
      };
      const [content, artifacts] = formatToolContent(result, 'google');
      expect(content).toBe('');
      expect(artifacts).toBeDefined();
      expect(artifacts?.content).toHaveLength(2);
    });

    it('should reject oversized base64 image data before creating artifacts', () => {
      process.env.MCP_IMAGE_DATA_MAX_BYTES = '3';
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'QUJDRA==', mimeType: 'image/png' }],
      };

      expect(() => formatToolContent(result, 'openai')).toThrow(
        'MCP image result exceeds maximum size of 3 bytes',
      );
    });

    it('should allow base64 image data when decoded size is within the cap', () => {
      process.env.MCP_IMAGE_DATA_MAX_BYTES = '4';
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'QUJDRA==', mimeType: 'image/png' }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');

      expect(content).toBe('');
      expect(artifacts?.content?.[0]).toEqual({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,QUJDRA==' },
      });
    });

    it('should reject oversized image data for unrecognized providers before stringifying', () => {
      process.env.MCP_IMAGE_DATA_MAX_BYTES = '3';
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'QUJDRA==', mimeType: 'image/png' }],
      };

      expect(() => formatToolContent(result, 'unknown' as t.Provider)).toThrow(
        'MCP image result exceeds maximum size of 3 bytes',
      );
    });

    it('should not apply the image data cap to remote image URLs', () => {
      process.env.MCP_IMAGE_DATA_MAX_BYTES = '3';
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'https://example.com/large.png', mimeType: 'image/png' }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');

      expect(content).toBe('');
      expect(artifacts?.content?.[0]).toEqual({
        type: 'image_url',
        image_url: { url: 'https://example.com/large.png' },
      });
    });

    it('should enforce the image cap on base64 data that merely starts with "http"', () => {
      process.env.MCP_IMAGE_DATA_MAX_BYTES = '3';
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'httpAAAAAAAA', mimeType: 'image/png' }],
      };

      expect(() => formatToolContent(result, 'openai')).toThrow(
        'MCP image result exceeds maximum size of 3 bytes',
      );
    });

    it('should treat base64 starting with "http" as inline data, not a remote URL', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'image', data: 'httpAAAA', mimeType: 'image/png' }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');

      expect(content).toBe('');
      expect(artifacts?.content?.[0]).toEqual({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,httpAAAA' },
      });
    });
  });

  describe('resource handling', () => {
    it('should handle UI resources in artifacts', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'ui://carousel',
              mimeType: 'application/json',
              text: '{"items": []}',
            },
          },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');
      expect(typeof content).toBe('string');
      expect(content).toContain('UI Resource ID:');
      expect(content).toContain('UI Resource Marker: \\ui{');
      expect(content).toContain('Resource URI: ui://carousel');
      expect(content).toContain('Resource MIME Type: application/json');

      const uiResourceArtifact = artifacts?.ui_resources?.data?.[0];
      expect(uiResourceArtifact).toBeTruthy();
      expect(uiResourceArtifact).toMatchObject({
        uri: 'ui://carousel',
        mimeType: 'application/json',
        text: '{"items": []}',
      });
      expect(uiResourceArtifact?.resourceId).toEqual(expect.any(String));
    });

    it('should handle regular resources', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'file://document.pdf',
              mimeType: 'application/pdf',
              text: 'Document content',
            },
          },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');
      expect(content).toBe(
        'Resource Text: Document content\n' +
          'Resource URI: file://document.pdf\n' +
          'Resource MIME Type: application/pdf',
      );
      expect(artifacts).toBeUndefined();
    });

    it('should handle resources with partial data', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'https://example.com/resource',
              text: '',
            },
          },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');
      expect(content).toBe('Resource URI: https://example.com/resource');
      expect(artifacts).toBeUndefined();
    });

    it('should handle mixed UI and regular resources', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          { type: 'text', text: 'Some text' },
          {
            type: 'resource',
            resource: {
              uri: 'ui://button',
              mimeType: 'application/json',
              text: '{"label": "Click me"}',
            },
          },
          {
            type: 'resource',
            resource: {
              uri: 'file://data.csv',
              text: '',
            },
          },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');
      expect(typeof content).toBe('string');
      expect(content).toContain('Some text');
      expect(content).toContain('UI Resource Marker: \\ui{');
      expect(content).toContain('Resource URI: ui://button');
      expect(content).toContain('Resource MIME Type: application/json');
      expect(content).toContain('Resource URI: file://data.csv');

      const uiResource = artifacts?.ui_resources?.data?.[0];
      expect(uiResource).toMatchObject({
        uri: 'ui://button',
        mimeType: 'application/json',
        text: '{"label": "Click me"}',
      });
      expect(uiResource?.resourceId).toEqual(expect.any(String));
    });

    it('should handle both images and UI resources in artifacts', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          { type: 'text', text: 'Content with multimedia' },
          { type: 'image', data: 'base64imagedata', mimeType: 'image/png' },
          {
            type: 'resource',
            resource: {
              uri: 'ui://graph',
              mimeType: 'application/json',
              text: '{"type": "line"}',
            },
          },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');
      expect(typeof content).toBe('string');
      expect(content).toContain('Content with multimedia');
      expect(content).toContain('UI Resource Marker: \\ui{');
      expect(content).toContain('Resource URI: ui://graph');
      expect(content).toContain('Resource MIME Type: application/json');
      expect(artifacts).toEqual({
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,base64imagedata' },
          },
        ],
        ui_resources: {
          data: [
            {
              uri: 'ui://graph',
              mimeType: 'application/json',
              text: '{"type": "line"}',
              resourceId: expect.any(String),
            },
          ],
        },
      });
    });
  });

  describe('unknown content types', () => {
    it('should stringify unknown content types', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          { type: 'text', text: 'Normal text' },
          { type: 'unknown', data: 'some data' } as unknown as t.ToolContentPart,
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');
      expect(content).toBe(
        'Normal text\n\n' + JSON.stringify({ type: 'unknown', data: 'some data' }, null, 2),
      );
      expect(artifacts).toBeUndefined();
    });
  });

  describe('complex scenarios', () => {
    it('should handle mixed content with all types', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          { type: 'text', text: 'Introduction' },
          { type: 'image', data: 'image1.png', mimeType: 'image/png' },
          { type: 'text', text: 'Middle section' },
          {
            type: 'resource',
            resource: {
              uri: 'ui://chart',
              mimeType: 'application/json',
              text: '{"type": "bar"}',
            },
          },
          {
            type: 'resource',
            resource: {
              uri: 'https://api.example.com/data',
              text: '',
            },
          },
          { type: 'image', data: 'https://example.com/image2.jpg', mimeType: 'image/jpeg' },
          { type: 'text', text: 'Conclusion' },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'anthropic');
      expect(typeof content).toBe('string');
      expect(content).toContain('Introduction');
      expect(content).toContain('Middle section');
      expect(content).toContain('UI Resource ID:');
      expect(content).toContain('UI Resource Marker: \\ui{');
      expect(content).toContain('Resource URI: ui://chart');
      expect(content).toContain('Resource MIME Type: application/json');
      expect(content).toContain('Resource URI: https://api.example.com/data');
      expect(content).toContain('Conclusion');
      expect(content).toContain('UI Resource Markers Available:');
      expect(artifacts).toMatchObject({
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,image1.png' },
          },
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/image2.jpg' },
          },
        ],
        ui_resources: {
          data: [
            {
              uri: 'ui://chart',
              mimeType: 'application/json',
              text: '{"type": "bar"}',
              resourceId: expect.any(String),
            },
          ],
        },
      });
    });

    it('should handle error responses gracefully', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'text', text: 'Error occurred' }],
        isError: true,
      };

      const [content, artifacts] = formatToolContent(result, 'openai');
      expect(content).toBe('Error occurred');
      expect(artifacts).toBeUndefined();
    });

    it('should handle metadata in responses', () => {
      const result: t.MCPToolCallResponse = {
        _meta: { timestamp: Date.now(), source: 'test' },
        content: [{ type: 'text', text: 'Response with metadata' }],
      };

      const [content, artifacts] = formatToolContent(result, 'google');
      expect(content).toBe('Response with metadata');
      expect(artifacts).toBeUndefined();
    });
  });

  describe('MCP citation detection', () => {
    const citationSource = {
      content: 'This page identifies HLW&rsquo;s approach and standards related to using worksets.',
      citation: 'https://hlw.atlassian.net/wiki/spaces/PD/pages/2107408385/Worksets',
      score: 12.154897,
    };

    it('extracts references and rewrites text when the tool result is a citation array', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'text', text: JSON.stringify([citationSource]) }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');

      expect(content).toContain('Worksets');
      expect(content).toContain(citationSource.citation);
      expect(content).toContain('\\ue202turn0ref0');
      expect(content).not.toContain('"score"');

      expect(artifacts?.[Tools.mcp_search]?.turn).toBe(0);
      const references = artifacts?.[Tools.mcp_search]?.references;
      expect(references).toHaveLength(1);
      expect(references?.[0]).toMatchObject({
        link: citationSource.citation,
        type: 'link',
        title: 'Worksets',
        attribution: 'Worksets',
      });
      expect(references?.[0].snippet?.length).toBeLessThanOrEqual(303);
      expect(references?.[0].snippet).not.toContain('&rsquo;');
    });

    it('assigns sequential indices for multiple sources in one call', () => {
      const secondSource = {
        content: 'Second source content.',
        citation: 'https://hlw.atlassian.net/wiki/spaces/PD/pages/2159673345/Modelling',
        score: 10.65,
      };
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'text', text: JSON.stringify([citationSource, secondSource]) }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');

      expect(content).toContain('\\ue202turn0ref0');
      expect(content).toContain('\\ue202turn0ref1');
      expect(artifacts?.[Tools.mcp_search]?.references).toHaveLength(2);
    });

    it('includes citation format instructions for the model', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'text', text: JSON.stringify([citationSource]) }],
      };

      const [content] = formatToolContent(result, 'openai');
      expect(content.toLowerCase()).toContain('citation format');
    });

    it('does not treat plain text as citations', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'text', text: 'Just a normal response, not JSON.' }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');
      expect(content).toBe('Just a normal response, not JSON.');
      expect(artifacts).toBeUndefined();
    });

    it('does not treat an unrelated JSON array as citations', () => {
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'text', text: JSON.stringify([{ id: 1, name: 'not a citation' }]) }],
      };

      const [, artifacts] = formatToolContent(result, 'openai');
      expect(artifacts).toBeUndefined();
    });

    it('detects citations in one text item while leaving another plain-text item untouched', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          { type: 'text', text: JSON.stringify([citationSource]) },
          { type: 'text', text: 'Some additional plain-text commentary.' },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');

      expect(content).toContain('\\ue202turn0ref0');
      expect(content).toContain('Some additional plain-text commentary.');
      expect(artifacts?.[Tools.mcp_search]?.references).toHaveLength(1);
    });

    it('rejects the whole array when it mixes citation-shaped and non-citation-shaped objects', () => {
      const result: t.MCPToolCallResponse = {
        content: [
          {
            type: 'text',
            text: JSON.stringify([citationSource, { id: 1, name: 'not a citation' }]),
          },
        ],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');

      expect(artifacts).toBeUndefined();
      expect(content).toBe(JSON.stringify([citationSource, { id: 1, name: 'not a citation' }]));
    });

    it('neutralizes a non-http(s) citation instead of rejecting the whole array', () => {
      const javascriptSource = {
        content: 'Malicious content',
        citation: 'javascript:alert(1)',
        score: 1,
      };
      const dataUriSource = {
        content: 'Malicious content',
        citation: 'data:text/html,<script>alert(1)</script>',
        score: 1,
      };

      const jsResult: t.MCPToolCallResponse = {
        content: [{ type: 'text', text: JSON.stringify([javascriptSource]) }],
      };
      const [jsContent, jsArtifacts] = formatToolContent(jsResult, 'openai');
      expect(jsArtifacts).toBeDefined();
      const jsReferences = jsArtifacts?.[Tools.mcp_search]?.references;
      expect(jsReferences).toHaveLength(1);
      expect(jsReferences?.[0].link).not.toBe('');
      expect(jsReferences?.[0].link).not.toContain('javascript:');
      expect(jsContent).toContain('\\ue202turn0ref0');

      const dataResult: t.MCPToolCallResponse = {
        content: [{ type: 'text', text: JSON.stringify([dataUriSource]) }],
      };
      const [, dataArtifacts] = formatToolContent(dataResult, 'openai');
      const dataReferences = dataArtifacts?.[Tools.mcp_search]?.references;
      expect(dataReferences).toHaveLength(1);
      expect(dataReferences?.[0].link).not.toBe('');
      expect(dataReferences?.[0].link).not.toContain('data:text/html');
    });

    it('uses an explicit title for display and the file:// UNC path as the real link', () => {
      const uncSource = {
        content: 'Proposal body text.',
        citation: 'file://hlw.com/global/Marketing/03-Prospects/2026/HLW%20Proposal.pdf#page=1',
        title: 'HLW Proposal.pdf',
        score: 54.27,
      };
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'text', text: JSON.stringify([uncSource]) }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');

      const references = artifacts?.[Tools.mcp_search]?.references;
      expect(references).toHaveLength(1);
      expect(references?.[0].link).toBe(uncSource.citation);
      expect(references?.[0].title).toBe('HLW Proposal.pdf');
      expect(content).toContain(`Source [0]: HLW Proposal.pdf (${uncSource.citation})`);
    });

    it('still neutralizes an unsafe-scheme citation even when an explicit title is present', () => {
      const maliciousSource = {
        content: 'Malicious content',
        citation: 'javascript:alert(1)',
        title: 'Looks legit',
        score: 1,
      };
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'text', text: JSON.stringify([maliciousSource]) }],
      };

      const [, artifacts] = formatToolContent(result, 'openai');

      const references = artifacts?.[Tools.mcp_search]?.references;
      expect(references).toHaveLength(1);
      expect(references?.[0].link).not.toContain('javascript:');
      expect(references?.[0].title).toBe('Looks legit');
    });

    it('accepts a citation array of bare filenames (real-world PDF-backed source shape)', () => {
      const fileSources = [
        {
          content: '2026 HLW HOLIDAYS \n \n\nU.S. HOLIDAYS...',
          citation: '2026 HLW Holiday Calendars.pdf',
          score: 26.059875,
        },
        {
          content: 'Employee handbook contents.',
          citation: 'HLW-US-Employee-Handbook-Aug2025.pdf',
          score: 8.493703,
        },
      ];
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'text', text: JSON.stringify(fileSources) }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');

      expect(artifacts).toBeDefined();
      const references = artifacts?.[Tools.mcp_search]?.references;
      expect(references).toHaveLength(2);
      expect(references?.[0].link).not.toBe('');
      expect(references?.[0].type).toBe('link');
      expect(references?.[0].title).toBe('2026 HLW Holiday Calendars.pdf');
      expect(content).toContain('Anchor: \\ue202turn0ref0');
      expect(content).toContain('Anchor: \\ue202turn0ref1');
    });

    it('handles a mixed array of URL and bare-filename citations without poisoning the whole batch', () => {
      const urlSource = {
        content: 'Worksets content.',
        citation: 'https://hlw.atlassian.net/wiki/spaces/PD/pages/2107408385/Worksets',
        score: 12.15,
      };
      const fileSource = {
        content: 'Holiday calendar content.',
        citation: '2026 HLW Holiday Calendars.pdf',
        score: 26.06,
      };
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'text', text: JSON.stringify([urlSource, fileSource]) }],
      };

      const [, artifacts] = formatToolContent(result, 'openai');

      const references = artifacts?.[Tools.mcp_search]?.references;
      expect(references).toHaveLength(2);
      expect(references?.[0].link).toBe(urlSource.citation);
      expect(references?.[0].type).toBe('link');
      expect(references?.[1].link).not.toBe('');
      expect(references?.[1].link).not.toBe(urlSource.citation);
      expect(references?.[1].type).toBe('link');
      expect(references?.[1].title).toBe('2026 HLW Holiday Calendars.pdf');
    });

    it('caps the title length for a non-URL citation instead of using it verbatim', () => {
      const longFilenameSource = {
        content: 'Some content.',
        citation: `${'a'.repeat(500)}.pdf`,
        score: 1,
      };
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'text', text: JSON.stringify([longFilenameSource]) }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');

      const references = artifacts?.[Tools.mcp_search]?.references;
      expect(references?.[0].title?.length).toBeLessThanOrEqual(203);
      expect(references?.[0].attribution?.length).toBeLessThanOrEqual(203);
      expect(content.length).toBeLessThan(longFilenameSource.citation.length + 1000);
    });

    it('caps the number of sources and truncates long per-source content', () => {
      const manySources = Array.from({ length: 25 }, (_, i) => ({
        content: 'x'.repeat(6000),
        citation: `https://hlw.atlassian.net/wiki/spaces/PD/pages/${1000 + i}/Page${i}`,
        score: i,
      }));
      const result: t.MCPToolCallResponse = {
        content: [{ type: 'text', text: JSON.stringify(manySources) }],
      };

      const [content, artifacts] = formatToolContent(result, 'openai');

      const references = artifacts?.[Tools.mcp_search]?.references;
      expect(references).toHaveLength(20);
      expect(content).toContain('\\ue202turn0ref19');
      expect(content).not.toContain('\\ue202turn0ref20');

      expect(content).toContain(`${'x'.repeat(5000)}...`);
      expect(content).not.toContain('x'.repeat(5001));
    });
  });
});

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
        attribution: citationSource.citation,
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
  });
});

import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { VendorLeadsDatabaseStack } from '../lib/vendor-leads-database-stack';
import { VendorLeadsStack } from '../lib/vendor-leads-stack';

/**
 * Synthesize the dev main stack with the same wiring the stage uses.
 * Uses cdk.json's salesforceDomain context so the Connection/API destinations resolve.
 */
function synthMainTemplate(stage = 'dev'): Template {
  const app = new App({
    context: {
      salesforceDomain: {
        dev: 'https://emortgage--r2d2.sandbox.my.salesforce.com',
        prod: 'https://emortgage.my.salesforce.com'
      },
      customDomain: {
        prod: {
          domainName: 'leads.emortgage-workflows.cloud',
          hostedZoneId: 'Z00218281R78MEBTJOL7Q',
          zoneName: 'emortgage-workflows.cloud'
        }
      }
    }
  });
  const db = new VendorLeadsDatabaseStack(app, `${stage}-VendorLeadsDatabase`, { stage });
  const stack = new VendorLeadsStack(app, `${stage}-VendorLeadsMain`, {
    stage,
    vendorLeadsTable: db.vendorLeadsTable
  });
  return Template.fromStack(stack);
}

describe('direct-leads endpoint (additive)', () => {
  const template = synthMainTemplate('dev');

  test('router Lambda is created', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'dev-direct-leads-router',
      Runtime: 'nodejs22.x'
    });
  });

  test('API Gateway exposes the direct-leads resource', () => {
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'direct-leads'
    });
  });

  test('dedicated Salesforce API destination exists', () => {
    template.hasResourceProperties('AWS::Events::ApiDestination', {
      Name: 'dev-salesforce-direct-leads-api-destination'
    });
  });

  test('rule matches the DirectLeadReceived.v1 detail type', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'dev-direct-leads-upsert-to-salesforce',
      EventPattern: Match.objectLike({
        source: ['vendorleads.upsert'],
        'detail-type': ['DirectLeadReceived.v1']
      })
    });
  });

  test('rule target maps vendor, emc_branch, and emc_user to query string parameters', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'dev-direct-leads-upsert-to-salesforce',
      Targets: Match.arrayWith([
        Match.objectLike({
          HttpParameters: {
            QueryStringParameters: {
              vendor: '$.detail.data.vendor',
              emc_branch: '$.detail.data.emcBranch',
              emc_user: '$.detail.data.emcUser'
            }
          }
        })
      ])
    });
  });
});

describe('existing endpoints unaffected (regression)', () => {
  const template = synthMainTemplate('dev');

  test('internet-leads and live-transfers routers still present', () => {
    template.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'dev-vendor-leads-post-router' });
    template.hasResourceProperties('AWS::Lambda::Function', { FunctionName: 'dev-live-transfer-router' });
  });

  test('internet + live-transfer rule targets carry vendor only (no routing params added)', () => {
    for (const ruleName of ['dev-vendor-leads-upsert-to-salesforce', 'dev-live-transfer-upsert-to-salesforce']) {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: ruleName,
        Targets: Match.arrayWith([
          Match.objectLike({
            HttpParameters: {
              QueryStringParameters: { vendor: '$.detail.data.vendor' }
            }
          })
        ])
      });
    }
  });

  test('three Salesforce API destinations total (internet, live-transfer, direct)', () => {
    template.resourceCountIs('AWS::Events::ApiDestination', 3);
  });
});

describe('custom domain (context-guarded, prod only)', () => {
  const prod = synthMainTemplate('prod');
  const dev = synthMainTemplate('dev');

  test('prod creates an ACM certificate for the custom domain', () => {
    prod.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'leads.emortgage-workflows.cloud',
      ValidationMethod: 'DNS'
    });
  });

  test('prod creates a regional API Gateway custom domain', () => {
    prod.hasResourceProperties('AWS::ApiGateway::DomainName', {
      DomainName: 'leads.emortgage-workflows.cloud',
      EndpointConfiguration: { Types: ['REGIONAL'] }
    });
  });

  test('prod maps the whole API to the custom domain (empty base path)', () => {
    prod.resourceCountIs('AWS::ApiGateway::BasePathMapping', 1);
  });

  test('prod creates the Route53 alias A record', () => {
    prod.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'A',
      Name: 'leads.emortgage-workflows.cloud.'
    });
  });

  test('dev has NO custom-domain resources (stays on execute-api)', () => {
    dev.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    dev.resourceCountIs('AWS::ApiGateway::DomainName', 0);
    dev.resourceCountIs('AWS::ApiGateway::BasePathMapping', 0);
    dev.resourceCountIs('AWS::Route53::RecordSet', 0);
  });
});

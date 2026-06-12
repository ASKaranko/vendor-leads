import { StackProps, Stack, CfnOutput, Tags, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import {
  LambdaRestApi,
  EndpointType,
  LogGroupLogDestination,
  AccessLogFormat,
  MethodLoggingLevel,
  AuthorizationType,
  LambdaIntegration,
  Cors,
  MockIntegration,
  PassthroughBehavior
} from 'aws-cdk-lib/aws-apigateway';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Queue, QueueEncryption, RedrivePermission } from 'aws-cdk-lib/aws-sqs';
import * as path from 'path';
import {
  ApiDestination as EventsApiDestination,
  EventBus,
  ArchiveProps,
  Connection,
  Authorization,
  HttpMethod,
  HttpParameter,
  Rule,
  RuleTargetInput
} from 'aws-cdk-lib/aws-events';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { ApiDestination as TargetsApiDestination, CloudWatchLogGroup as EventsCloudWatchLogGroup } from 'aws-cdk-lib/aws-events-targets';
import { TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { SecretValue } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';

interface VendorLeadsStackProps extends StackProps {
  stage: string;
  vendorLeadsTable: TableV2;
}

export class VendorLeadsStack extends Stack {
  constructor(scope: Construct, id: string, props: VendorLeadsStackProps) {
    super(scope, id, props);

    const stage = props.stage || 'dev';
    const vendorLeadsTable = props.vendorLeadsTable;

    const salesforceEventBusName = `${stage}-salesforce-event-bus`;
    const salesforceEventRuleSource = 'vendorleads.upsert';
    const salesforceLeadsDetailType = 'LeadsReceived.v1';
    const salesforceLiveTransferDetailType = 'LiveTransferReceived.v1';
    const salesforceDirectLeadsDetailType = 'DirectLeadReceived.v1';

    // Salesforce domain per stage is sourced from cdk.json context.
    // To repoint at a new sandbox (e.g. after refresh), edit `cdk.json` →
    // `context.salesforceDomain.<stage>` and redeploy. No code change needed.
    const salesforceDomainConfig = this.node.tryGetContext('salesforceDomain') as Record<string, string> | undefined;
    const endpointDomain = salesforceDomainConfig?.[stage];
    if (!endpointDomain) {
      throw new Error(
        `Missing CDK context 'salesforceDomain.${stage}' in cdk.json. ` + `Add the Salesforce domain for stage '${stage}' before deploying.`
      );
    }

    const salesforceLeadsRestAPIPath = '/services/apexrest/vendor-api/v1/leads/';
    const salesforceLiveTransfersRestAPIPath = '/services/apexrest/vendor-api/v1/live-transfers/';
    const salesforceDirectLeadsRestAPIPath = '/services/apexrest/vendor-api/v1/direct-leads/';
    const salesforceOAuthPath = '/services/oauth2/token';

    const secretStoreNameForExtClientAppCreds = `${stage}/salesforce/sf-lead-store-app-creds`;
    const vendorsConfigParameterPath = `/${stage}/vendor-leads/vendors`;

    new CfnOutput(this, 'Stage', {
      value: stage,
      description: 'The deployment stage'
    });

    //stack level tags
    Tags.of(this).add('Project', 'vendor-leads');
    Tags.of(this).add('Environment', stage);

    const routerFnLogGroup = new LogGroup(this, 'PostRouterLogGroup', {
      logGroupName: `/aws/lambda/${stage}-vendor-leads-post-router`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const ddbWriterFnLogGroup = new LogGroup(this, 'DDBWriterLogGroup', {
      logGroupName: `/aws/lambda/${stage}-vendor-leads-ddb-writer`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const postRouterLambda = new NodejsFunction(this, 'VendorLeadsPostRouter', {
      functionName: `${stage}-vendor-leads-post-router`,
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.X86_64,
      entry: path.join(__dirname, '../lambda/routes/post-router.js'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(20),
      environment: {
        SALESFORCE_EVENT_BUS_NAME: salesforceEventBusName,
        SALESFORCE_EVENT_BUS_RULE_SOURCE: salesforceEventRuleSource,
        STAGE: `${stage}`
      },
      logGroup: routerFnLogGroup
    });

    const liveTransferRouterFnLogGroup = new LogGroup(this, 'LiveTransferRouterLogGroup', {
      logGroupName: `/aws/lambda/${stage}-live-transfer-router`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const liveTransferRouterLambda = new NodejsFunction(this, 'LiveTransferRouter', {
      functionName: `${stage}-live-transfer-router`,
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.X86_64,
      entry: path.join(__dirname, '../lambda/routes/live-transfer-router.js'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        SALESFORCE_EVENT_BUS_NAME: salesforceEventBusName,
        SALESFORCE_EVENT_BUS_RULE_SOURCE: salesforceEventRuleSource,
        STAGE: `${stage}`
      },
      logGroup: liveTransferRouterFnLogGroup
    });

    const directLeadsRouterFnLogGroup = new LogGroup(this, 'DirectLeadsRouterLogGroup', {
      logGroupName: `/aws/lambda/${stage}-direct-leads-router`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const directLeadsRouterLambda = new NodejsFunction(this, 'DirectLeadsRouter', {
      functionName: `${stage}-direct-leads-router`,
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.X86_64,
      entry: path.join(__dirname, '../lambda/routes/direct-leads-router.js'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        SALESFORCE_EVENT_BUS_NAME: salesforceEventBusName,
        SALESFORCE_EVENT_BUS_RULE_SOURCE: salesforceEventRuleSource,
        STAGE: `${stage}`
      },
      logGroup: directLeadsRouterFnLogGroup
    });

    const ddbWriterLambda = new NodejsFunction(this, 'VendorLeadsDDBWriter', {
      functionName: `${stage}-vendor-leads-ddb-writer`,
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.X86_64,
      entry: path.join(__dirname, '../lambda/database/ddb-writer.js'),
      handler: 'handler',
      memorySize: 128,
      timeout: Duration.seconds(5),
      logGroup: ddbWriterFnLogGroup,
      environment: {
        STAGE: `${stage}`
      }
    });

    const apiGatewayLogGroup = new LogGroup(this, 'ApiGatewayLogGroup', {
      logGroupName: `/aws/apigateway/${stage}-vendor-leads-api`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const eventBusLogGroup = new LogGroup(this, 'EventBusLogGroup', {
      logGroupName: `/aws/events/${salesforceEventBusName}`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY
    });

    // Replace manual API Gateway with LambdaRestApi
    const api = new LambdaRestApi(this, 'VendorLeadsApi', {
      restApiName: `${stage}-vendor-leads-api`,
      description: 'API for processing vendor leads',
      handler: postRouterLambda,
      endpointTypes: [EndpointType.REGIONAL],
      cloudWatchRole: true,
      cloudWatchRoleRemovalPolicy: RemovalPolicy.DESTROY,
      proxy: false,
      deployOptions: {
        stageName: stage,
        description: `Deployment for ${stage} environment`,
        metricsEnabled: true,
        throttlingRateLimit: 200,
        throttlingBurstLimit: 300,
        accessLogDestination: new LogGroupLogDestination(apiGatewayLogGroup),
        accessLogFormat: AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: MethodLoggingLevel.INFO
      },
      defaultMethodOptions: {
        authorizationType: AuthorizationType.NONE,
        apiKeyRequired: false
      },
      defaultCorsPreflightOptions: {
        allowOrigins: Cors.ALL_ORIGINS,
        allowMethods: ['POST', 'GET', 'OPTIONS'],
        allowHeaders: ['*'],
        maxAge: Duration.seconds(86400) // 24 hours
      }
    });

    const leadsResource = api.root.addResource('leads', {
      defaultCorsPreflightOptions: {
        allowOrigins: ['*'],
        allowMethods: ['POST', 'GET', 'OPTIONS'],
        allowHeaders: ['*'],
        maxAge: Duration.seconds(86400)
      }
    });

    leadsResource.addMethod(
      'POST',
      new LambdaIntegration(postRouterLambda, {
        proxy: true,
        allowTestInvoke: true
      })
    );

    // Add GET method with MockIntegration
    // Return a response without sending the request further to the backend
    leadsResource.addMethod(
      'GET',
      new MockIntegration({
        integrationResponses: [
          {
            statusCode: '200',
            responseParameters: {
              'method.response.header.Content-Type': "'application/json'",
              'method.response.header.Access-Control-Allow-Origin': "'*'"
            },
            responseTemplates: {
              'application/json': '{"message": "Please use POST method to send lead data"}'
            }
          }
        ],
        passthroughBehavior: PassthroughBehavior.NEVER,
        requestTemplates: {
          'application/json': '{"statusCode": 200}'
        }
      }),
      {
        methodResponses: [
          {
            statusCode: '200',
            responseParameters: {
              'method.response.header.Content-Type': true,
              'method.response.header.Access-Control-Allow-Origin': true
            }
          }
        ]
      }
    );

    // Live-transfer endpoint: POST /v1/live-transfers
    const v1Resource = api.root.addResource('v1', {
      defaultCorsPreflightOptions: {
        allowOrigins: ['*'],
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['*'],
        maxAge: Duration.seconds(86400)
      }
    });
    const liveTransfersResource = v1Resource.addResource('live-transfers', {
      defaultCorsPreflightOptions: {
        allowOrigins: ['*'],
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['*'],
        maxAge: Duration.seconds(86400)
      }
    });

    liveTransfersResource.addMethod(
      'POST',
      new LambdaIntegration(liveTransferRouterLambda, {
        proxy: true,
        allowTestInvoke: true
      })
    );

    // Direct-leads endpoint: POST /v1/direct-leads
    const directLeadsResource = v1Resource.addResource('direct-leads', {
      defaultCorsPreflightOptions: {
        allowOrigins: ['*'],
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['*'],
        maxAge: Duration.seconds(86400)
      }
    });

    directLeadsResource.addMethod(
      'POST',
      new LambdaIntegration(directLeadsRouterLambda, {
        proxy: true,
        allowTestInvoke: true
      })
    );

    new CfnOutput(this, 'ApiEndpoint', {
      value: api.url,
      description: 'The URL of the API Gateway endpoint'
    });

    const vendorLeadsDDBDeadLetterQueue = new Queue(this, 'VendorLeadsDDBDeadLetterQueue', {
      queueName: `${stage}-vendor-leads-ddb-dlq`,
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.DESTROY
    });

    const vendorLeadsEventDeadLetterQueue = new Queue(this, 'VendorLeadsEventDeadLetterQueue', {
      queueName: `${stage}-vendor-leads-event-dlq`,
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      removalPolicy: RemovalPolicy.DESTROY
    });

    const vendorLeadsDDBQueue = new Queue(this, 'VendorLeadsDDBQueue', {
      queueName: `${stage}-vendor-leads-ddb-queue`,
      encryption: QueueEncryption.SQS_MANAGED,
      deliveryDelay: Duration.seconds(0),
      visibilityTimeout: Duration.seconds(30),
      receiveMessageWaitTime: Duration.seconds(20),
      retentionPeriod: Duration.minutes(5),
      maxMessageSizeBytes: 262144, // 256KB
      deadLetterQueue: {
        queue: vendorLeadsDDBDeadLetterQueue,
        maxReceiveCount: 3
      },
      redriveAllowPolicy: {
        redrivePermission: RedrivePermission.DENY_ALL
      },
      removalPolicy: RemovalPolicy.DESTROY
    });

    // Grant the Lambda functions permission to send/consume messages on the queue
    vendorLeadsDDBQueue.grantSendMessages(postRouterLambda);
    vendorLeadsDDBQueue.grantSendMessages(liveTransferRouterLambda);
    vendorLeadsDDBQueue.grantSendMessages(directLeadsRouterLambda);
    vendorLeadsDDBQueue.grantConsumeMessages(ddbWriterLambda);

    // Per-vendor SSM parameters under /${stage}/vendor-leads/vendors/<name>.
    // All three Lambdas read the path via GetParametersByPath; grant wildcard access.
    const vendorsConfigSsmArn = `arn:aws:ssm:${this.region}:${this.account}:parameter${vendorsConfigParameterPath}/*`;
    const ssmReadPolicy = new PolicyStatement({
      actions: ['ssm:GetParametersByPath'],
      resources: [vendorsConfigSsmArn]
    });
    postRouterLambda.addToRolePolicy(ssmReadPolicy);
    liveTransferRouterLambda.addToRolePolicy(ssmReadPolicy);
    directLeadsRouterLambda.addToRolePolicy(ssmReadPolicy);
    ddbWriterLambda.addToRolePolicy(ssmReadPolicy);

    // Update Lambda environment variables to include the queue URL
    postRouterLambda.addEnvironment('LEADS_TO_DYNAMODB_SQS_URL', vendorLeadsDDBQueue.queueUrl);
    liveTransferRouterLambda.addEnvironment('LEADS_TO_DYNAMODB_SQS_URL', vendorLeadsDDBQueue.queueUrl);
    directLeadsRouterLambda.addEnvironment('LEADS_TO_DYNAMODB_SQS_URL', vendorLeadsDDBQueue.queueUrl);

    // If you want ddbWriterLambda to process messages from the queue
    ddbWriterLambda.addEventSource(
      new SqsEventSource(vendorLeadsDDBQueue, {
        batchSize: 10,
        maxBatchingWindow: Duration.seconds(5),
        maxConcurrency: 10,
        reportBatchItemFailures: true
      })
    );

    new CfnOutput(this, 'VendorLeadsDDBQueueUrl', {
      value: vendorLeadsDDBQueue.queueUrl,
      description: 'The URL of the DDB SQS queue'
    });

    vendorLeadsTable.grantReadWriteData(ddbWriterLambda);
    ddbWriterLambda.addEnvironment('VENDOR_LEADS_TABLE_NAME', vendorLeadsTable.tableName);

    // EventBridge setup
    // Create an EventBridge event bus
    const eventBus = new EventBus(this, 'SalesforceEventBus', {
      eventBusName: salesforceEventBusName,
      description:
        'This event bus delivers different events to various Salesforce instances (production or sandbox), depending on the integration—such as for the lead store.'
    });
    eventBus.applyRemovalPolicy(RemovalPolicy.DESTROY);

    eventBus.grantPutEventsTo(postRouterLambda);
    eventBus.grantPutEventsTo(liveTransferRouterLambda);
    eventBus.grantPutEventsTo(directLeadsRouterLambda);

    // Configure event bus archive with retention and AWS-owned encryption
    const archiveProps: ArchiveProps = {
      archiveName: `${stage}-salesforce-event-bus-archive`,
      description: 'Archive for Salesforce event bus events',
      retention: Duration.days(90),
      eventPattern: {
        // Empty pattern to capture all events
      },
      sourceEventBus: eventBus
    };
    eventBus.archive('SalesforceEventBusArchive', archiveProps);

    Tags.of(eventBus).add('Project', 'vendor-leads');
    Tags.of(eventBus).add('Environment', stage);

    // Connection with client-credentials OAuth (endpointDomain comes from cdk.json context — see top of stack)
    const connection = new Connection(this, 'SalesforceConnection', {
      connectionName: `${stage}-salesforce-connection`,
      description: 'OAuth-client-credentials connection to Salesforce',
      authorization: Authorization.oauth({
        authorizationEndpoint: `${endpointDomain}${salesforceOAuthPath}`,
        httpMethod: HttpMethod.POST,
        clientId: SecretValue.secretsManager(`${secretStoreNameForExtClientAppCreds}`, {
          jsonField: 'client_id' // Specify the key within the secret
        }).unsafeUnwrap(),
        clientSecret: SecretValue.secretsManager(`${secretStoreNameForExtClientAppCreds}`, {
          jsonField: 'client_secret'
        }),
        bodyParameters: {
          grant_type: HttpParameter.fromString('client_credentials')
        },
        headerParameters: {
          'Content-Type': HttpParameter.fromString('application/x-www-form-urlencoded')
        }
      })
    });

    // API destination for internet leads
    const dest = new EventsApiDestination(this, 'SalesforceVendorLeadsAPIDest', {
      apiDestinationName: `${stage}-salesforce-vendor-leads-api-destination`,
      description: 'API destination for Salesforce vendor leads',
      connection,
      endpoint: `${endpointDomain}${salesforceLeadsRestAPIPath}`,
      httpMethod: HttpMethod.POST,
      rateLimitPerSecond: 10
    });

    // Rule that sends internet-lead events to the Salesforce destination.
    // Detail path is `$.detail.data.leads` to match the metadata envelope shape.
    const salesforceRule = new Rule(this, 'VendorLeadsUpsertToSalesforce', {
      ruleName: `${stage}-vendor-leads-upsert-to-salesforce`,
      description: 'Rule to send vendor leads to Salesforce',
      eventBus,
      eventPattern: {
        source: [salesforceEventRuleSource],
        detailType: [salesforceLeadsDetailType]
      }
    });
    salesforceRule.applyRemovalPolicy(RemovalPolicy.DESTROY);
    salesforceRule.addTarget(
      new TargetsApiDestination(dest, {
        deadLetterQueue: vendorLeadsEventDeadLetterQueue,
        maxEventAge: Duration.minutes(15),
        retryAttempts: 3,
        queryStringParameters: {
          vendor: '$.detail.data.vendor'
        },
        event: RuleTargetInput.fromEventPath('$.detail.data.leads')
      })
    );

    // API destination for live-transfer leads — separate Salesforce REST endpoint, same OAuth connection
    const liveTransferDest = new EventsApiDestination(this, 'SalesforceLiveTransfersAPIDest', {
      apiDestinationName: `${stage}-salesforce-live-transfers-api-destination`,
      description: 'API destination for Salesforce live-transfer leads',
      connection,
      endpoint: `${endpointDomain}${salesforceLiveTransfersRestAPIPath}`,
      httpMethod: HttpMethod.POST,
      rateLimitPerSecond: 10
    });

    const liveTransferRule = new Rule(this, 'LiveTransferUpsertToSalesforce', {
      ruleName: `${stage}-live-transfer-upsert-to-salesforce`,
      description: 'Rule to send live-transfer leads to Salesforce',
      eventBus,
      eventPattern: {
        source: [salesforceEventRuleSource],
        detailType: [salesforceLiveTransferDetailType]
      }
    });
    liveTransferRule.applyRemovalPolicy(RemovalPolicy.DESTROY);
    liveTransferRule.addTarget(
      new TargetsApiDestination(liveTransferDest, {
        deadLetterQueue: vendorLeadsEventDeadLetterQueue,
        maxEventAge: Duration.minutes(15),
        retryAttempts: 3,
        queryStringParameters: {
          vendor: '$.detail.data.vendor'
        },
        event: RuleTargetInput.fromEventPath('$.detail.data.leads')
      })
    );

    // API destination for direct leads — separate Salesforce REST endpoint, same OAuth connection
    const directLeadsDest = new EventsApiDestination(this, 'SalesforceDirectLeadsAPIDest', {
      apiDestinationName: `${stage}-salesforce-direct-leads-api-destination`,
      description: 'API destination for Salesforce direct leads',
      connection,
      endpoint: `${endpointDomain}${salesforceDirectLeadsRestAPIPath}`,
      httpMethod: HttpMethod.POST,
      rateLimitPerSecond: 10
    });

    const directLeadsRule = new Rule(this, 'DirectLeadsUpsertToSalesforce', {
      ruleName: `${stage}-direct-leads-upsert-to-salesforce`,
      description: 'Rule to send direct leads to Salesforce',
      eventBus,
      eventPattern: {
        source: [salesforceEventRuleSource],
        detailType: [salesforceDirectLeadsDetailType]
      }
    });
    directLeadsRule.applyRemovalPolicy(RemovalPolicy.DESTROY);
    directLeadsRule.addTarget(
      new TargetsApiDestination(directLeadsDest, {
        deadLetterQueue: vendorLeadsEventDeadLetterQueue,
        maxEventAge: Duration.minutes(15),
        retryAttempts: 3,
        queryStringParameters: {
          vendor: '$.detail.data.vendor',
          dst: '$.detail.data.dst'
        },
        event: RuleTargetInput.fromEventPath('$.detail.data.leads')
      })
    );

    //logging rule
    const sfEventBusLoggingRule = new Rule(this, 'SFEventBusLoggingRule', {
      ruleName: `${stage}-sf-event-bus-logging-rule`,
      description: 'Rule to log all events from the Salesforce event bus',
      eventBus,
      eventPattern: {
        account: [Stack.of(this).account] // matches all events
      }
    });
    sfEventBusLoggingRule.applyRemovalPolicy(RemovalPolicy.DESTROY);
    sfEventBusLoggingRule.addTarget(
      new EventsCloudWatchLogGroup(eventBusLogGroup, {
        maxEventAge: Duration.minutes(15),
        retryAttempts: 3
      })
    );
  }
}

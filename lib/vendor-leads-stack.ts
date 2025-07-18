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
  Cors
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
    const salesforceEventDetailType = 'LeadsReceived';

    const sandboxDomain = 'https://emortgage--godspeed.sandbox.my.salesforce.com';
    const productionDomain = 'https://emortgage.my.salesforce.com';
    const salesforceRestAPIPath = '/services/apexrest/vendor-api/v1/leads/';
    const salesforceOAuthPath = '/services/oauth2/token';

    const secretStoreNameForExtClientAppCreds = `${stage}/salesforce/sf-lead-store-app-creds`;
    const parameterStoreNameForVendorsConfig = `/${stage}/vendor-leads/vendors-config`;

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
        SALESFORCE_EVENT_BUS_RULE_DETAIL_TYPE: salesforceEventDetailType,
        STAGE: `${stage}`
      },
      logGroup: routerFnLogGroup
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
        authorizationType: AuthorizationType.NONE
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

    // Grant the Lambda function permission to send messages to the queue
    vendorLeadsDDBQueue.grantSendMessages(postRouterLambda);
    vendorLeadsDDBQueue.grantConsumeMessages(ddbWriterLambda);

    ddbWriterLambda.addToRolePolicy(
      new PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${parameterStoreNameForVendorsConfig}`]
      })
    );

    // Update Lambda environment variables to include the queue URL
    postRouterLambda.addEnvironment('LEADS_TO_DYNAMODB_SQS_URL', vendorLeadsDDBQueue.queueUrl);

    // add Parameter Store access to postRouterLambda
    postRouterLambda.addToRolePolicy(
      new PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${parameterStoreNameForVendorsConfig}`]
      })
    );

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

    const endpointDomain = stage === 'prod' ? productionDomain : sandboxDomain;
    // Connection with client-credentials OAuth
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

    // API destination (HTTP endpoint)
    const dest = new EventsApiDestination(this, 'SalesforceVendorLeadsAPIDest', {
      apiDestinationName: `${stage}-salesforce-vendor-leads-api-destination`,
      description: 'API destination for Salesforce vendor leads',
      connection,
      endpoint: `${endpointDomain}${salesforceRestAPIPath}`,
      httpMethod: HttpMethod.POST,
      rateLimitPerSecond: 10
    });

    // Rule that sends matching events to the destination (using custom pattern)
    const salesforceRule = new Rule(this, 'VendorLeadsUpsertToSalesforce', {
      ruleName: `${stage}-vendor-leads-upsert-to-salesforce`,
      description: 'Rule to send vendor leads to Salesforce',
      eventBus,
      eventPattern: {
        source: [salesforceEventRuleSource],
        detailType: [salesforceEventDetailType]
      }
    });
    salesforceRule.applyRemovalPolicy(RemovalPolicy.DESTROY);
    salesforceRule.addTarget(
      new TargetsApiDestination(dest, {
        deadLetterQueue: vendorLeadsEventDeadLetterQueue,
        maxEventAge: Duration.minutes(15),
        retryAttempts: 3,
        queryStringParameters: {
          vendor: '$.detail.vendor'
        },
        event: RuleTargetInput.fromEventPath('$.detail.leads')
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

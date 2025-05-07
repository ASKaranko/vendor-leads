import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as path from 'path';
import * as events from 'aws-cdk-lib/aws-events';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { ApiDestination, CloudWatchLogGroup } from 'aws-cdk-lib/aws-events-targets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { SecretValue } from 'aws-cdk-lib';

interface VendorLeadsStackProps extends cdk.StackProps {
  stage: string;
  vendorLeadsTable: dynamodb.TableV2;
}

export class VendorLeadsStack extends cdk.Stack {
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

    const clientIdSSMName = `${stage}/SFClientId`;
    const clientSecretSSMName = `${stage}/SFClientSecret`;

    new cdk.CfnOutput(this, 'Stage', {
      value: stage,
      description: 'The deployment stage'
    });

    //stack level tags
    cdk.Tags.of(this).add('Project', 'vendor-leads');
    cdk.Tags.of(this).add('Environment', stage);

    const routerFnLogGroup = new LogGroup(this, 'PostRouterLogGroup', {
      logGroupName: `/aws/lambda/${stage}-vendor-leads-post-router`,
      retention: RetentionDays.INFINITE,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const ddbWriterFnLogGroup = new LogGroup(this, 'DDBWriterLogGroup', {
      logGroupName: `/aws/lambda/${stage}-vendor-leads-ddb-writer`,
      retention: RetentionDays.INFINITE,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const postRouterLambda = new NodejsFunction(this, 'VendorLeadsPostRouter', {
      functionName: `${stage}-vendor-leads-post-router`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.X86_64,
      entry: path.join(__dirname, '../lambda/routes/post-router.js'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(20),
      environment: {
        SALESFORCE_EVENT_BUS_NAME: salesforceEventBusName,
        SALESFORCE_EVENT_BUS_RULE_SOURCE: salesforceEventRuleSource,
        SALESFORCE_EVENT_BUS_RULE_DETAIL_TYPE: salesforceEventDetailType
      },
      logGroup: routerFnLogGroup
    });

    const ddbWriterLambda = new NodejsFunction(this, 'VendorLeadsDDBWriter', {
      functionName: `${stage}-vendor-leads-ddb-writer`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.X86_64,
      entry: path.join(__dirname, '../lambda/database/ddb-writer.js'),
      handler: 'handler',
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      logGroup: ddbWriterFnLogGroup
    });

    const apiGatewayLogGroup = new LogGroup(this, 'ApiGatewayLogGroup', {
      logGroupName: `/aws/apigateway/${stage}-vendor-leads-api`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const eventBusLogGroup = new LogGroup(this, 'EventBusLogGroup', {
      logGroupName: `/aws/events/${salesforceEventBusName}`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Replace manual API Gateway with LambdaRestApi
    const api = new apigw.LambdaRestApi(this, 'VendorLeadsApi', {
      restApiName: `${stage}-vendor-leads-api`,
      description: 'API for processing vendor leads',
      handler: postRouterLambda,
      endpointTypes: [apigw.EndpointType.REGIONAL],
      cloudWatchRole: true,
      cloudWatchRoleRemovalPolicy: cdk.RemovalPolicy.DESTROY,
      proxy: false,
      deployOptions: {
        stageName: stage,
        description: `Deployment for ${stage} environment`,
        metricsEnabled: true,
        throttlingRateLimit: 200,
        throttlingBurstLimit: 300,
        accessLogDestination: new apigw.LogGroupLogDestination(apiGatewayLogGroup),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields(),
        loggingLevel: apigw.MethodLoggingLevel.ERROR
      },
      defaultMethodOptions: {
        authorizationType: apigw.AuthorizationType.NONE
      }
    });

    // Add /leads resource with POST method
    const leadsResource = api.root.addResource('leads');
    leadsResource.addMethod('POST');

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: api.url,
      description: 'The URL of the API Gateway endpoint'
    });

    const vendorLeadsDDBDeadLetterQueue = new sqs.Queue(this, 'VendorLeadsDDBDeadLetterQueue', {
      queueName: `${stage}-vendor-leads-ddb-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const vendorLeadsEventDeadLetterQueue = new sqs.Queue(this, 'VendorLeadsEventDeadLetterQueue', {
      queueName: `${stage}-vendor-leads-event-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const vendorLeadsDDBQueue = new sqs.Queue(this, 'VendorLeadsDDBQueue', {
      queueName: `${stage}-vendor-leads-ddb-queue`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deliveryDelay: cdk.Duration.seconds(0),
      visibilityTimeout: cdk.Duration.seconds(30),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      retentionPeriod: cdk.Duration.minutes(5),
      maxMessageSizeBytes: 262144, // 256KB
      deadLetterQueue: {
        queue: vendorLeadsDDBDeadLetterQueue,
        maxReceiveCount: 3
      },
      redriveAllowPolicy: {
        redrivePermission: sqs.RedrivePermission.DENY_ALL
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Grant the Lambda function permission to send messages to the queue
    vendorLeadsDDBQueue.grantSendMessages(postRouterLambda);
    vendorLeadsDDBQueue.grantConsumeMessages(ddbWriterLambda);

    // Update Lambda environment variables to include the queue URL
    postRouterLambda.addEnvironment('LEADS_TO_DYNAMODB_SQS_URL', vendorLeadsDDBQueue.queueUrl);

    // Alternative: If you want ddbWriterLambda to process messages from the queue
    ddbWriterLambda.addEventSource(
      new SqsEventSource(vendorLeadsDDBQueue, {
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(5),
        maxConcurrency: 10,
        reportBatchItemFailures: true
      })
    );

    new cdk.CfnOutput(this, 'VendorLeadsDDBQueueUrl', {
      value: vendorLeadsDDBQueue.queueUrl,
      description: 'The URL of the DDB SQS queue'
    });

    vendorLeadsTable.grantReadWriteData(ddbWriterLambda);
    ddbWriterLambda.addEnvironment('VENDOR_LEADS_TABLE_NAME', vendorLeadsTable.tableName);

    // EventBridge setup
    // Create an EventBridge event bus
    const eventBus = new events.EventBus(this, 'SalesforceEventBus', {
      eventBusName: salesforceEventBusName,
      description:
        'This event bus delivers different events to various Salesforce instances (production or sandbox), depending on the integration—such as for the lead store.'
    });
    eventBus.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    eventBus.grantPutEventsTo(postRouterLambda);

    // Configure event bus archive with retention and AWS-owned encryption
    const archiveProps: events.ArchiveProps = {
      archiveName: `${stage}-salesforce-event-bus-archive`,
      description: 'Archive for Salesforce event bus events',
      retention: cdk.Duration.days(90),
      eventPattern: {
        // Empty pattern to capture all events
      },
      sourceEventBus: eventBus
    };
    eventBus.archive('SalesforceEventBusArchive', archiveProps);

    cdk.Tags.of(eventBus).add('Project', 'vendor-leads');
    cdk.Tags.of(eventBus).add('Environment', stage);

    const endpointDomain = stage === 'prod' ? productionDomain : sandboxDomain;
    // Connection with client-credentials OAuth
    const connection = new events.Connection(this, 'SalesforceConnection', {
      connectionName: `${stage}-salesforce-connection`,
      description: 'OAuth-client-credentials connection to Salesforce',
      authorization: events.Authorization.oauth({
        authorizationEndpoint: `${endpointDomain}${salesforceOAuthPath}`,
        httpMethod: events.HttpMethod.POST,
        clientId: SecretValue.secretsManager(`${clientIdSSMName}`, {
          jsonField: 'client_id' // Specify the key within the secret
        }).unsafeUnwrap(),
        clientSecret: SecretValue.secretsManager(`${clientSecretSSMName}`, {
          jsonField: 'client_secret'
        }),
        bodyParameters: {
          grant_type: events.HttpParameter.fromString('client_credentials')
        },
        headerParameters: {
          'Content-Type': events.HttpParameter.fromString('application/x-www-form-urlencoded')
        }
      })
    });

    // API destination (HTTP endpoint)
    const dest = new events.ApiDestination(this, 'SalesforceVendorLeadsAPIDest', {
      apiDestinationName: `${stage}-salesforce-vendor-leads-api-destination`,
      description: 'API destination for Salesforce vendor leads',
      connection,
      endpoint: `${endpointDomain}${salesforceRestAPIPath}`,
      httpMethod: events.HttpMethod.POST,
      rateLimitPerSecond: 10
    });

    // Rule that sends matching events to the destination (using custom pattern)
    const salesforceRule = new events.Rule(this, 'VendorLeadsUpsertToSalesforce', {
      ruleName: `${stage}-vendor-leads-upsert-to-salesforce`,
      description: 'Rule to send vendor leads to Salesforce',
      eventBus,
      eventPattern: {
        source: [salesforceEventRuleSource],
        detailType: [salesforceEventDetailType]
      }
    });
    salesforceRule.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    salesforceRule.addTarget(
      new ApiDestination(dest, {
        deadLetterQueue: vendorLeadsEventDeadLetterQueue,
        maxEventAge: cdk.Duration.minutes(15),
        retryAttempts: 3,
        queryStringParameters: {
          vendor: '$.detail.vendor'
        },
        event: events.RuleTargetInput.fromEventPath('$.detail.leads')
      })
    );

    cdk.Tags.of(salesforceRule).add('Project', 'vendor-leads');
    cdk.Tags.of(salesforceRule).add('Environment', stage);

    //logging rule
    const sfEventBusLoggingRule = new events.Rule(this, 'SFEventBusLoggingRule', {
      ruleName: `${stage}-sf-event-bus-logging-rule`,
      description: 'Rule to log all events from the Salesforce event bus',
      eventBus,
      eventPattern: {
        account: [cdk.Stack.of(this).account]   // matches all events
      }
    });
    sfEventBusLoggingRule.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    sfEventBusLoggingRule.addTarget(
      new CloudWatchLogGroup(eventBusLogGroup, {
        maxEventAge: cdk.Duration.minutes(15),
        retryAttempts: 3,
      })
    );

    cdk.Tags.of(sfEventBusLoggingRule).add('Project', 'vendor-leads');
    cdk.Tags.of(sfEventBusLoggingRule).add('Environment', stage);
  }
}

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

interface VendorLeadsDatabaseStackProps extends cdk.StackProps {
  stage: string;
}

export class VendorLeadsDatabaseStack extends cdk.Stack {
  public readonly vendorLeadsTable: dynamodb.TableV2;
  
  constructor(scope: Construct, id: string, props: VendorLeadsDatabaseStackProps) {
    super(scope, id, props);

    const stage = props.stage;

    // Stack level tags
    cdk.Tags.of(this).add('project', 'vendor-leads');
    cdk.Tags.of(this).add('stage', stage);

    // Create DynamoDB TableV2
    this.vendorLeadsTable = new dynamodb.TableV2(this, 'VendorLeadsTable', {
      tableName: `${stage}-vendor-leads-table`,
      partitionKey: { name: 'LeadId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'VendorName', type: dynamodb.AttributeType.STRING },
      tableClass: dynamodb.TableClass.STANDARD,
      deletionProtection: true,
      encryption: dynamodb.TableEncryptionV2.dynamoOwnedKey(),
      warmThroughput: {
        readUnitsPerSecond: 12000,
        writeUnitsPerSecond: 4000,
      },
    });

    // Export the table name
    new cdk.CfnOutput(this, 'VendorLeadsTableName', {
      value: this.vendorLeadsTable.tableName,
      description: 'The name of the vendor leads table',
    });
  }
}
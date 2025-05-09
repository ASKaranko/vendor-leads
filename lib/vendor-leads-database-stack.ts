import { StackProps, Stack, Tags, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { TableV2, AttributeType, TableClass, TableEncryptionV2 } from 'aws-cdk-lib/aws-dynamodb';

interface VendorLeadsDatabaseStackProps extends StackProps {
  stage: string;
}

export class VendorLeadsDatabaseStack extends Stack {
  public readonly vendorLeadsTable: TableV2;

  constructor(scope: Construct, id: string, props: VendorLeadsDatabaseStackProps) {
    super(scope, id, props);

    const stage = props.stage;

    // Stack level tags
    Tags.of(this).add('project', 'vendor-leads');
    Tags.of(this).add('stage', stage);

    // Create DynamoDB TableV2
    this.vendorLeadsTable = new TableV2(this, 'VendorLeadsTable', {
      tableName: `${stage}-vendor-leads-table`,
      partitionKey: { name: 'LeadId', type: AttributeType.STRING },
      sortKey: { name: 'VendorName', type: AttributeType.STRING },
      tableClass: TableClass.STANDARD,
      deletionProtection: true,
      encryption: TableEncryptionV2.dynamoOwnedKey(),
      warmThroughput: {
        readUnitsPerSecond: 12000,
        writeUnitsPerSecond: 4000
      }
    });

    // Export the table name
    new CfnOutput(this, 'VendorLeadsTableName', {
      value: this.vendorLeadsTable.tableName,
      description: 'The name of the vendor leads table'
    });
  }
}

import { Stage, StageProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { VendorLeadsDatabaseStack } from './vendor-leads-database-stack';
import { VendorLeadsStack } from './vendor-leads-stack';

interface VendorLeadsStageProps extends StageProps {
  stage: string;
}

export class VendorLeadsStage extends Stage {
  constructor(scope: Construct, id: string, props: VendorLeadsStageProps) {
    super(scope, id, props);

    const stage = props.stage || 'dev';

    // Create the database stack first
    const databaseStack = new VendorLeadsDatabaseStack(this, 'VendorLeadsDatabase', {
      stage
    });

    // Create the main stack, passing the table from the database stack
    new VendorLeadsStack(this, 'VendorLeadsMain', {
      stage,
      vendorLeadsTable: databaseStack.vendorLeadsTable
    });
  }
}

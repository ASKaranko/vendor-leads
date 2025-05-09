#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { VendorLeadsStage } from '../lib/vendor-leads-stage';

const app = new App();

// Create a stage for each environment
new VendorLeadsStage(app, 'dev', {
  stage: 'dev',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
});

// You can add more stages for other environments
new VendorLeadsStage(app, 'prod', {
  stage: 'prod',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
});

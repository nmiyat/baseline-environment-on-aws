import * as cdk from '@aws-cdk/core';
import * as dynamodb from '@aws-cdk/aws-dynamodb';
import * as lambda from '@aws-cdk/aws-lambda';
import * as kms from '@aws-cdk/aws-kms';
import * as iam from '@aws-cdk/aws-iam';
import * as sns from '@aws-cdk/aws-sns';
import * as logs from '@aws-cdk/aws-logs';
import * as cw from '@aws-cdk/aws-cloudwatch';
import * as cw_actions from '@aws-cdk/aws-cloudwatch-actions';
import * as path from 'path';

export interface BLEALambdaPythonStackProps extends cdk.StackProps {
  alarmTopic: sns.Topic;
  table: dynamodb.Table;
  appKey: kms.Key;
}
export class BLEALambdaPythonStack extends cdk.Stack {
  public readonly getItemFunction: lambda.Function;
  public readonly listItemsFunction: lambda.Function;
  public readonly putItemFunction: lambda.Function;

  constructor(scope: cdk.Construct, id: string, props: BLEALambdaPythonStackProps) {
    super(scope, id, props);

    // Custom Policy for App Key
    props.appKey.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['kms:*'],
        principals: [new iam.AccountRootPrincipal()],
        resources: ['*'],
      }),
    );
    props.appKey.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        principals: [
          new iam.AnyPrincipal().withConditions({
            ArnLike: {
              'aws:PrincipalArn': `arn:aws:iam::${cdk.Stack.of(this).account}:role/BLEA-LambdaPython-*`,
            },
          }),
        ],
        resources: ['*'],
      }),
    );

    // Policy operating KMS CMK for Lambda
    const kmsPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
      resources: [props.appKey.keyArn],
    });

    // Using Lambda Python Library
    //
    // !!!! CAUTION !!!!
    // Lambda Python Library is experimental. This implementation might be changed.
    // See: https://docs.aws.amazon.com/cdk/api/latest/docs/aws-lambda-python-readme.html
    //

    // Lambda layer for Lambda Powertools
    // For install instruction, See: https://awslabs.github.io/aws-lambda-powertools-python/latest/#install
    const lambdaPowertools = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'lambda-powertools',
      `arn:aws:lambda:${cdk.Stack.of(this).region}:017000801446:layer:AWSLambdaPowertoolsPython:3`,
    );

    // GetItem Function
    const getItemFunction = new lambda.Function(this, 'getItem', {
      runtime: lambda.Runtime.PYTHON_3_7,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/python/getItem')),
      handler: 'getItem.lambda_handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(25),
      tracing: lambda.Tracing.ACTIVE,
      insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_98_0,
      layers: [lambdaPowertools],
      environment: {
        DDB_TABLE: props.table.tableName,
      },
      environmentEncryption: props.appKey,
      logRetention: logs.RetentionDays.THREE_MONTHS,
    });
    getItemFunction.addToRolePolicy(kmsPolicy);
    getItemFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:Query', 'dynamodb:GetItem'],
        resources: [props.table.tableArn, props.table.tableArn + '/index/*'],
      }),
    );
    this.getItemFunction = getItemFunction;

    // Sample metrics and alarm
    // See: https://docs.aws.amazon.com/wellarchitected/latest/serverless-applications-lens/best-practices.html
    getItemFunction
      .metricErrors({
        period: cdk.Duration.minutes(1),
        statistic: cw.Statistic.AVERAGE,
      })
      .createAlarm(this, 'getItemErrorsAlarm', {
        evaluationPeriods: 3,
        threshold: 80,
        datapointsToAlarm: 3,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      })
      .addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    getItemFunction
      .metricDuration({
        period: cdk.Duration.minutes(1),
        statistic: cw.Statistic.AVERAGE,
      })
      .createAlarm(this, 'getItemDurationAlarm', {
        evaluationPeriods: 3,
        threshold: 80,
        datapointsToAlarm: 3,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      })
      .addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    new cw.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'ConcurrentExecutions',
      period: cdk.Duration.minutes(5),
      statistic: cw.Statistic.MAXIMUM,
      dimensionsMap: {
        FunctionName: getItemFunction.functionName,
      },
    })
      .createAlarm(this, 'getItemConcurrentExecutionsAlarm', {
        evaluationPeriods: 3,
        threshold: 80,
        datapointsToAlarm: 3,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      })
      .addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    getItemFunction
      .metricThrottles({
        period: cdk.Duration.minutes(1),
        statistic: cw.Statistic.AVERAGE,
      })
      .createAlarm(this, 'getItemThrottlesAlarm', {
        evaluationPeriods: 3,
        threshold: 80,
        datapointsToAlarm: 3,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      })
      .addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    // ListItem Function
    const listItemsFunction = new lambda.Function(this, 'listItems', {
      runtime: lambda.Runtime.PYTHON_3_7,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/python/listItems')),
      handler: 'listItems.lambda_handler',
      timeout: cdk.Duration.seconds(25),
      memorySize: 2048,
      tracing: lambda.Tracing.ACTIVE,
      insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_98_0,
      layers: [lambdaPowertools],
      environment: {
        DDB_TABLE: props.table.tableName,
      },
      environmentEncryption: props.appKey,
      logRetention: logs.RetentionDays.THREE_MONTHS,
    });
    listItemsFunction.addToRolePolicy(kmsPolicy);
    listItemsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:Query', 'dynamodb:Scan'],
        resources: [props.table.tableArn, props.table.tableArn + '/index/*'],
      }),
    );
    this.listItemsFunction = listItemsFunction;

    // Sample metrics and alarm
    // See: https://docs.aws.amazon.com/wellarchitected/latest/serverless-applications-lens/best-practices.html
    listItemsFunction
      .metricErrors({
        period: cdk.Duration.minutes(1),
        statistic: cw.Statistic.AVERAGE,
      })
      .createAlarm(this, 'listItemsErrorsExecutionsAlarm', {
        evaluationPeriods: 3,
        threshold: 80,
        datapointsToAlarm: 3,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      })
      .addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    listItemsFunction
      .metricDuration({
        period: cdk.Duration.minutes(1),
        statistic: cw.Statistic.AVERAGE,
      })
      .createAlarm(this, 'listItemsDurationAlarm', {
        evaluationPeriods: 3,
        threshold: 80,
        datapointsToAlarm: 3,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      })
      .addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    new cw.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'ConcurrentExecutions',
      period: cdk.Duration.minutes(5),
      statistic: cw.Statistic.MAXIMUM,
      dimensionsMap: {
        FunctionName: listItemsFunction.functionName,
      },
    })
      .createAlarm(this, 'listItemsConcurrentExecutionsAlarm', {
        evaluationPeriods: 3,
        threshold: 80,
        datapointsToAlarm: 3,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      })
      .addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    listItemsFunction
      .metricThrottles({
        period: cdk.Duration.minutes(1),
        statistic: cw.Statistic.AVERAGE,
      })
      .createAlarm(this, 'listItemsThrottlesAlarm', {
        evaluationPeriods: 3,
        threshold: 80,
        datapointsToAlarm: 3,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      })
      .addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    // PutItem Function
    const putItemFunction = new lambda.Function(this, 'putItem', {
      runtime: lambda.Runtime.PYTHON_3_7,
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/python/putItem')),
      handler: 'putItem.lambda_handler',
      timeout: cdk.Duration.seconds(25),
      memorySize: 256,
      tracing: lambda.Tracing.ACTIVE,
      insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_98_0,
      layers: [lambdaPowertools],
      environment: {
        DDB_TABLE: props.table.tableName,
      },
      environmentEncryption: props.appKey,
      logRetention: logs.RetentionDays.THREE_MONTHS,
    });
    putItemFunction.addToRolePolicy(kmsPolicy);
    putItemFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [props.table.tableArn, props.table.tableArn + '/index/*'],
      }),
    );
    this.putItemFunction = putItemFunction;

    // Sample metrics and alarm
    // See: https://docs.aws.amazon.com/wellarchitected/latest/serverless-applications-lens/best-practices.html
    putItemFunction
      .metricErrors({
        period: cdk.Duration.minutes(1),
        statistic: cw.Statistic.AVERAGE,
      })
      .createAlarm(this, 'putItemErrorsAlarm', {
        evaluationPeriods: 3,
        threshold: 80,
        datapointsToAlarm: 3,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      })
      .addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    putItemFunction
      .metricDuration({
        period: cdk.Duration.minutes(1),
        statistic: cw.Statistic.AVERAGE,
      })
      .createAlarm(this, 'putItemDurationAlarm', {
        evaluationPeriods: 3,
        threshold: 80,
        datapointsToAlarm: 3,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      })
      .addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    new cw.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'ConcurrentExecutions',
      period: cdk.Duration.minutes(5),
      statistic: cw.Statistic.MAXIMUM,
      dimensionsMap: {
        FunctionName: putItemFunction.functionName,
      },
    })
      .createAlarm(this, 'putItemConcurrentExecutionsAlarm', {
        evaluationPeriods: 3,
        threshold: 80,
        datapointsToAlarm: 3,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      })
      .addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    putItemFunction
      .metricThrottles({
        period: cdk.Duration.minutes(1),
        statistic: cw.Statistic.AVERAGE,
      })
      .createAlarm(this, 'putItemThrottlesAlarm', {
        evaluationPeriods: 3,
        threshold: 80,
        datapointsToAlarm: 3,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        actionsEnabled: true,
      })
      .addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));
  }
}

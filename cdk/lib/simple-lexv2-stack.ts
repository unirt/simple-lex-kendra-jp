import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lex from 'aws-cdk-lib/aws-lex';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as idPool from '@aws-cdk/aws-cognito-identitypool-alpha';
import * as kendra from 'aws-cdk-lib/aws-kendra';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as waf from 'aws-cdk-lib/aws-wafv2';
import { GeoRestriction } from 'aws-cdk-lib/aws-cloudfront';
import { NodejsBuild } from 'deploy-time-build';
import { CloudFrontToS3 } from '@aws-solutions-constructs/aws-cloudfront-s3';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NagSuppressions } from 'cdk-nag';

export interface SimpleLexV2StackProps extends cdk.StackProps {
  kendraIndex: kendra.CfnIndex;
  latestBotVersion: number;
  autoIncrementBotVersion: boolean;
  // webAclCloudFront: waf.CfnWebACL;
}

export class SimpleLexV2Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SimpleLexV2StackProps) {
    super(scope, id, props);

    const fulfillmentFunc = new lambda.NodejsFunction(
      this,
      'FulfillmentFunction',
      {
        runtime: Runtime.NODEJS_18_X,
        entry: './lambda/lex-fulfillment.ts',
        timeout: cdk.Duration.minutes(3),
        environment: {
          INDEX_ID: props.kendraIndex.ref,
          REGION: this.region,
        },
      }
    );

    fulfillmentFunc.role?.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['kendra:Query'],
        resources: [cdk.Token.asString(props.kendraIndex.getAtt('Arn'))],
      })
    );

    const botRole = new iam.Role(this, 'BotRole', {
      assumedBy: new iam.ServicePrincipal('lexv2.amazonaws.com'),
    });

    const bot = new lex.CfnBot(this, 'Bot', {
      name: 'SimpleBot',
      roleArn: botRole.roleArn,
      dataPrivacy: {
        ChildDirected: false,
      },
      idleSessionTtlInSeconds: 300,
      autoBuildBotLocales: false,
      botLocales: [
        {
          localeId: 'ja_JP',
          nluConfidenceThreshold: 0.85,
          slotTypes: [
            {
              name: 'PCTypes',
              valueSelectionSetting: {
                resolutionStrategy: 'TOP_RESOLUTION',
              },
              slotTypeValues: [
                {
                  sampleValue: { value: 'Windows' },
                  synonyms: [{ value: 'ウィンドウズ' }],
                },
                {
                  sampleValue: { value: 'Mac' },
                  synonyms: [{ value: 'マック' }],
                },
              ],
            },
          ],
          intents: [
            {
              name: 'FallbackIntent',
              description:
                'いずれの Intent にも該当しない場合、Kendra をキックする',
              parentIntentSignature: 'AMAZON.FallbackIntent',
              fulfillmentCodeHook: { enabled: true },
              initialResponseSetting: {
                initialResponse: {
                  messageGroupsList: [
                    {
                      message: {
                        plainTextMessage: {
                          value:
                            '対応方法がわかりませんでした。社内ドキュメントを検索します。',
                        },
                      },
                    },
                  ],
                },
              },
            },
            {
              name: 'PCReplacementIntent',
              description: 'パソコンの交換',
              sampleUtterances: [
                { utterance: 'PCを交換' },
                { utterance: 'パソコンが壊れた' },
              ],
              slots: [
                {
                  name: 'PCType',
                  slotTypeName: 'PCTypes',
                  valueElicitationSetting: {
                    slotConstraint: 'Required',
                    promptSpecification: {
                      maxRetries: 3,
                      messageGroupsList: [
                        {
                          message: {
                            plainTextMessage: {
                              value:
                                'PC の交換を行います。現在ご利用中の PC の種類を教えてください (Mac or Windows)',
                            },
                          },
                        },
                      ],
                    },
                  },
                },
                {
                  name: 'PickupDate',
                  slotTypeName: 'AMAZON.Date',
                  valueElicitationSetting: {
                    slotConstraint: 'Required',
                    promptSpecification: {
                      maxRetries: 3,
                      messageGroupsList: [
                        {
                          message: {
                            plainTextMessage: {
                              value: '何日に {PCType} を受け取りますか？',
                            },
                          },
                        },
                      ],
                    },
                  },
                },
                {
                  name: 'PickupTime',
                  slotTypeName: 'AMAZON.Time',
                  valueElicitationSetting: {
                    slotConstraint: 'Required',
                    promptSpecification: {
                      maxRetries: 3,
                      messageGroupsList: [
                        {
                          message: {
                            plainTextMessage: {
                              value:
                                '{PickupDate} の何時に新しい {PCType} を受け取りますか？',
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
              slotPriorities: [
                { priority: 1, slotName: 'PCType' },
                { priority: 2, slotName: 'PickupDate' },
                { priority: 3, slotName: 'PickupTime' },
              ],
              intentConfirmationSetting: {
                promptSpecification: {
                  maxRetries: 3,
                  messageGroupsList: [
                    {
                      message: {
                        plainTextMessage: {
                          value:
                            '{PCType} は {PickupDate} の {PickupTime} に受け取ることができます。これで良いですか？',
                        },
                      },
                    },
                  ],
                },
                declinationResponse: {
                  messageGroupsList: [
                    {
                      message: {
                        plainTextMessage: {
                          value: '交換対応をキャンセルしました',
                        },
                      },
                    },
                  ],
                },
              },
              fulfillmentCodeHook: { enabled: true },
            },
          ],
        },
      ],
    });

    const botVersion =
      props.latestBotVersion + (props.autoIncrementBotVersion ? 1 : 0);
    const latestVersion = new lex.CfnBotVersion(
      this,
      `BotVersion${botVersion}`,
      {
        botId: bot.ref,
        botVersionLocaleSpecification: [
          {
            localeId: 'ja_JP',
            botVersionLocaleDetails: {
              sourceBotVersion: 'DRAFT',
            },
          },
        ],
      }
    );

    const latestAlias = new lex.CfnBotAlias(this, 'LatestAlias', {
      botId: bot.ref,
      botAliasName: 'LatestAlias',
      botVersion: cdk.Token.asString(latestVersion.getAtt('BotVersion')),
      botAliasLocaleSettings: [
        {
          botAliasLocaleSetting: {
            codeHookSpecification: {
              lambdaCodeHook: {
                codeHookInterfaceVersion: '1.0',
                lambdaArn: fulfillmentFunc.functionArn,
              },
            },
            enabled: true,
          },
          localeId: 'ja_JP',
        },
      ],
    });

    fulfillmentFunc.addPermission('AllowLexToInvoke', {
      principal: new iam.ServicePrincipal('lexv2.amazonaws.com'),
      sourceAccount: this.account,
      sourceArn: latestAlias.attrArn,
      action: 'lambda:invokeFunction',
    });

    // -----
    // Identity Pool の作成
    // -----

    const identityPool = new idPool.IdentityPool(this, 'IdentityPoolForLex', {
      allowUnauthenticatedIdentities: true,
    });

    // Unauthorized User に以下の権限 (Lex, Transcribe, S3) を付与
    identityPool.unauthenticatedRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'lex:DeleteSession',
          'lex:PutSession',
          'lex:RecognizeText',
          'transcribe:StartStreamTranscriptionWebSocket',
          's3:GetObject',
        ],
        resources: ['*'],
      })
    );

    // -----
    // Frontend のデプロイ
    // -----

    const { cloudFrontWebDistribution, s3BucketInterface } = new CloudFrontToS3(
      this,
      'Frontend',
      {
        insertHttpSecurityHeaders: false,
        bucketProps: {
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          encryption: s3.BucketEncryption.S3_MANAGED,
          enforceSSL: true,
          autoDeleteObjects: true,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        },
        loggingBucketProps: {
          autoDeleteObjects: true,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
          serverAccessLogsPrefix: 'logs',
        },
        cloudFrontLoggingBucketProps: {
          autoDeleteObjects: true,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
          serverAccessLogsPrefix: 'logs',
        },
        cloudFrontDistributionProps: {
          geoRestriction: GeoRestriction.allowlist('JP'),
          // webAclId: props.webAclCloudFront.attrArn,
        },
      }
    );

    new NodejsBuild(this, 'WebLexV2', {
      assets: [
        {
          path: '../',
          exclude: [
            '.git',
            'node_modules',
            'cdk',
            'docs',
            'imgs',
            'web-kendra',
            'web-lexv2/build',
            'web-lexv2/node_modules',
          ],
        },
      ],
      destinationBucket: s3BucketInterface,
      distribution: cloudFrontWebDistribution,
      outputSourceDirectory: 'web-lexv2/build',
      buildCommands: ['npm install -w web-lexv2', 'npm run build -w web-lexv2'],
      buildEnvironment: {
        REACT_APP_BOT_ID: bot.ref,
        REACT_APP_BOT_ALIAS_ID: cdk.Token.asString(
          latestAlias.getAtt('BotAliasId')
        ),
        REACT_APP_IDENTITY_POOL_ID: identityPool.identityPoolId,
        REACT_APP_REGION: this.region,
      },
    });

    // -----
    // Stack の出力を定義
    // -----

    new cdk.CfnOutput(this, 'BotId', {
      value: bot.ref,
    });

    new cdk.CfnOutput(this, 'BotAliasId', {
      value: cdk.Token.asString(latestAlias.getAtt('BotAliasId')),
    });

    new cdk.CfnOutput(this, 'BotVersionNumber', {
      value: botVersion.toString(),
    });

    new cdk.CfnOutput(this, 'IdentityPoolId', {
      value: identityPool.identityPoolId,
    });

    new cdk.CfnOutput(this, 'LexV2SampleFrontend', {
      value: `https://${cloudFrontWebDistribution.distributionDomainName}`,
    });

    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'Managed role is allowed is this case',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Wildcard permission is allowed in this case',
      },
      {
        id: 'AwsSolutions-APIG2',
        reason: 'Validation method for REST API is not required',
      },
      {
        id: 'AwsSolutions-APIG4',
        reason: 'Authorization is not required for this API',
      },
      {
        id: 'AwsSolutions-COG4',
        reason: 'Cognito authorizer is not required for this API',
      },
      {
        id: 'AwsSolutions-COG7',
        reason: 'Unauthorized user is allowed to call Lex and Transcribe API',
      },
      {
        id: 'AwsSolutions-CFR4',
        reason: 'Allow to use default certificate',
      },
      {
        id: 'AwsSolutions-CB4',
        reason: 'KMS is not used, because Codebuild is encrypted by default',
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'Use fixed version of runtime',
      },
    ]);
  }
}

export const outcomeRegistryAbi = [
  {
    type: 'function',
    name: 'recordOutcome',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'bytes32' },
      { name: 'agreementHash', type: 'bytes32' },
      { name: 'submissionHash', type: 'bytes32' },
      { name: 'verificationReportHash', type: 'bytes32' },
      { name: 'buyerIdentityHash', type: 'bytes32' },
      { name: 'providerIdentityHash', type: 'bytes32' },
      { name: 'outcome', type: 'uint8' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'outcomes',
    stateMutability: 'view',
    inputs: [{ name: 'jobId', type: 'bytes32' }],
    outputs: [
      { name: 'agreementHash', type: 'bytes32' },
      { name: 'submissionHash', type: 'bytes32' },
      { name: 'verificationReportHash', type: 'bytes32' },
      { name: 'buyerIdentityHash', type: 'bytes32' },
      { name: 'providerIdentityHash', type: 'bytes32' },
      { name: 'outcome', type: 'uint8' },
      { name: 'finalizedAt', type: 'uint64' },
    ],
  },
] as const;

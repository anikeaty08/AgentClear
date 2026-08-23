import { parseAbi } from 'viem';

export const jobEscrowAbi = parseAbi([
  'function fundJob(bytes32 jobId, address provider, uint64 deadline, bytes32 agreementHash) payable',
  'function assignProvider(bytes32 jobId, address provider)',
  'function escrows(bytes32 jobId) view returns (address buyer, address provider, uint128 amount, uint64 deadline, uint8 state, bytes32 agreementHash)',
]);

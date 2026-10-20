import React from 'react'
import {
  BatchDiffTracksModal,
  BatchDiffTracksModalProps,
} from './BatchDiffTracksModal'

export type BatchAiTracksModalProps = BatchDiffTracksModalProps

/**
 * Backward compatibility wrapper: BatchAiTracksModal forwards to BatchDiffTracksModal.
 */
export const BatchAiTracksModal: React.FC<BatchAiTracksModalProps> = (props) => {
  return <BatchDiffTracksModal {...props} />
}

export { BatchDiffTracksModal }
export default BatchDiffTracksModal

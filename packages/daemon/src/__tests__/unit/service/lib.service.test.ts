import {
  sinon
} from '@loopback/testlab';
import test from 'ava';
import * as fs from "fs-extra";
import * as cp from 'child_process';

import { LibService } from '../../../services';


function initPipelineService(): {
  libService: LibService
  } {
  const libService = new LibService();
  return {
    libService
  };
}

// test the job service
test.serial.afterEach(() => {
  sinon.restore();
});

test.serial('get pipeline by id or name', async (t) => {
  const { libService } = initPipelineService();

  const mockFsPathExists = sinon.stub(fs, 'pathExists').resolves(true);
  sinon.replace(cp, 'exec', (cmd: string, opts: any, cb?: (error: cp.ExecException | null, stdout: string, stderr: string) => void) => {
    if (cb) {
      cb(null, '', '');
    }
  });
  libService.installByName('tvm');

  t.true(mockFsPathExists.called, 'check pathExists');
});

import {
  sinon
} from '@loopback/testlab';
import test from 'ava';
import * as boa from '@pipcook/boa';
import * as utils from '../../../convertor/utils';

test.serial.afterEach(() => {
  sinon.restore();
});

test.serial('test initTVM', async (t) => {

  const mockImport = sinon.stub(boa, 'import').returns({});

  utils.initTVM();

  t.true(mockImport.calledThrice, 'import should be called thrice');
});

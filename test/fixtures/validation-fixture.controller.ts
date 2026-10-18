import { Body, Controller, Post } from '@nestjs/common';
import { ValidationFixtureDto } from './validation-fixture.dto';

@Controller('test-fixture')
export class ValidationFixtureController {
  /** Create a validation fixture. */
  @Post()
  create(@Body() body: ValidationFixtureDto): ValidationFixtureDto {
    return body;
  }
}
